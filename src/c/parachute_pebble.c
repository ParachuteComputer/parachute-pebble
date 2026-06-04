// Parachute — capture from your wrist into your Parachute vault.
//
// The watch has NO internet. This C app only collects a capture (a voice
// dictation, or a tap on a configurable quick-log) and hands the text to the
// phone over AppMessage. The phone-side code (src/pkjs/index.js) does the actual
// HTTP POST to your vault, then sends back an ACK. The watch shows Sending /
// Saving / Saved / Queued / Failed — plus the transcript it captured.
//
// VOICE-FIRST: launching the app starts dictation immediately — open, speak,
// done. BACK during the first dictation lands on the menu (quick-logs, if you
// configured any; there are none by default).
//
// CHAINED DICTATION (longer than the firmware's ~15s): PebbleOS hard-caps a
// single DictationSession recording at ~15s (DICTATION_TIMEOUT). We chain legs:
// if a leg's wall-clock suggests the cap cut you off mid-riff, the next leg
// starts automatically — keep talking through the beep. Stop talking (silence)
// or stop early (Select) and the stitched note sends as one capture. The
// heuristic costs nothing when wrong: a riff just ends one leg early.
//
// Reliability (per Pebble AppMessage best practices):
//   - one in-flight message at a time; sends gated on a JS_READY handshake
//   - APP_MSG_BUSY / transient send failures retry with bounded backoff
//   - every capture carries a monotonic SEQ so pkjs can dedupe a redelivery
//   - an ACK watchdog rescues the UI if the phone never replies

#include <pebble.h>

#define DICTATION_BUFFER_SIZE 768   // per-leg transcript buffer (~15s of speech)
#define ACCUM_TEXT_MAX 4000         // stitched multi-leg note budget (clamped by outbox)
#define INBOX_SIZE 768              // holds the QUICK_LOGS list (+ small ACK/JS_READY)
#define BUSY_RETRY_MS 200
#define SEND_RETRY_MS 500
#define READY_FALLBACK_MS 3000
#define ACK_WATCHDOG_MS 18000
#define RESULT_VISIBLE_MS 1800
#define RESULT_VISIBLE_LONG_MS 5200 // when a transcript is on screen, linger
#define MAX_ATTEMPTS 8

// A dictation leg's elapsed time (listening + transcription) at or above this
// means the ~15s firmware cap almost certainly ended it, not the speaker —
// 15000ms of listening plus any processing. Short utterances only cross this
// if transcription itself takes >7s, which local STT doesn't.
#define AUTO_CONTINUE_MS 15500

// Quick-logs: tap-to-capture a fixed #capture/text note. NONE by default —
// voice is the product. Add your own on the phone config page; they're pushed
// over QUICK_LOGS and the menu rebuilds live.
#define MAX_QUICK_LOGS 10
#define LABEL_MAX 28
#define TEXT_MAX 80

typedef struct {
  char label[LABEL_MAX];
  char text[TEXT_MAX];
} QuickLog;

static QuickLog s_logs[MAX_QUICK_LOGS];
static int s_log_count;
static bool s_has_voice_item;

// ---------- state ----------
static Window *s_menu_window;
static MenuLayer *s_menu_layer;

#if defined(PBL_MICROPHONE)
static DictationSession *s_dictation_session;
#endif

static bool s_js_ready;
static uint32_t s_seq;
static int s_attempts;

// pending capture (one at a time), sized for a full stitched note
static bool s_has_pending;
static uint32_t s_pending_key;
static char s_pending_text[ACCUM_TEXT_MAX];

// chained-dictation accumulator
static char s_accum[ACCUM_TEXT_MAX];
static size_t s_accum_len;
static size_t s_text_budget;     // usable bytes given the negotiated outbox
static uint64_t s_leg_start_ms;

static AppTimer *s_retry_timer;
static AppTimer *s_ready_fallback_timer;
static AppTimer *s_ack_timer;

static Window *s_result_window;
static TextLayer *s_result_text;
static TextLayer *s_result_detail;
static const char *s_result_detail_ptr; // points at static buffers only
static AppTimer *s_result_dismiss_timer;
static char s_result_buf[64];

static void try_send_pending(void);
static void start_voice_leg(void);

static uint64_t now_ms(void) {
  time_t sec;
  uint16_t ms;
  time_ms(&sec, &ms);
  return (uint64_t)sec * 1000 + ms;
}

// ---------- quick-logs parsing ----------
static void trim_copy(char *dst, size_t dstsize, const char *src, int len) {
  while (len > 0 && (*src == ' ' || *src == '\t' || *src == '\r')) {
    src++;
    len--;
  }
  while (len > 0 && (src[len - 1] == ' ' || src[len - 1] == '\t' || src[len - 1] == '\r')) {
    len--;
  }
  if ((size_t)len >= dstsize) {
    len = dstsize - 1;
  }
  memcpy(dst, src, len);
  dst[len] = '\0';
}

// Parse "Label | note text" lines (one per line) into s_logs. An empty or
// unusable config simply means no quick-logs — voice-only.
static void apply_quick_logs(const char *cfg) {
  s_log_count = 0;
  if (!cfg) {
    return;
  }
  const char *p = cfg;
  while (*p && s_log_count < MAX_QUICK_LOGS) {
    const char *nl = strchr(p, '\n');
    int linelen = nl ? (int)(nl - p) : (int)strlen(p);
    const char *bar = memchr(p, '|', linelen);
    if (bar) {
      int llen = (int)(bar - p);
      int tstart = llen + 1;
      int tlen = linelen - tstart;
      if (tlen > 0) {
        trim_copy(s_logs[s_log_count].label, LABEL_MAX, p, llen);
        trim_copy(s_logs[s_log_count].text, TEXT_MAX, p + tstart, tlen);
        if (s_logs[s_log_count].label[0] && s_logs[s_log_count].text[0]) {
          s_log_count++;
        }
      }
    }
    if (!nl) {
      break;
    }
    p = nl + 1;
  }
}

// ---------- result window (status + transcript) ----------
static void result_dismiss_cb(void *data) {
  s_result_dismiss_timer = NULL;
  if (s_result_window) {
    window_stack_remove(s_result_window, true);
  }
}

static void result_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  s_result_text = text_layer_create(GRect(4, 2, b.size.w - 8, 34));
  text_layer_set_text_alignment(s_result_text, GTextAlignmentCenter);
  text_layer_set_font(s_result_text, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  text_layer_set_text(s_result_text, s_result_buf);
  layer_add_child(root, text_layer_get_layer(s_result_text));

  s_result_detail = text_layer_create(GRect(6, 40, b.size.w - 12, b.size.h - 44));
  text_layer_set_text_alignment(s_result_detail, GTextAlignmentCenter);
  text_layer_set_font(s_result_detail, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_overflow_mode(s_result_detail, GTextOverflowModeTrailingEllipsis);
  if (s_result_detail_ptr) {
    text_layer_set_text(s_result_detail, s_result_detail_ptr);
  }
  layer_add_child(root, text_layer_get_layer(s_result_detail));
}

static void result_window_unload(Window *window) {
  if (s_result_text) {
    text_layer_destroy(s_result_text);
    s_result_text = NULL;
  }
  if (s_result_detail) {
    text_layer_destroy(s_result_detail);
    s_result_detail = NULL;
  }
  window_destroy(s_result_window);
  s_result_window = NULL;
}

static void set_result_buf(const char *msg) {
  strncpy(s_result_buf, msg, sizeof(s_result_buf) - 1);
  s_result_buf[sizeof(s_result_buf) - 1] = '\0';
}

// detail must point at static storage (s_pending_text) or be NULL.
static void set_result_detail(const char *detail) {
  s_result_detail_ptr = detail;
  if (s_result_detail) {
    text_layer_set_text(s_result_detail, detail ? detail : "");
  }
}

static void show_result_window(const char *msg) {
  set_result_buf(msg);
  if (!s_result_window) {
    s_result_window = window_create();
    window_set_window_handlers(s_result_window, (WindowHandlers){
      .load = result_window_load,
      .unload = result_window_unload,
    });
    window_stack_push(s_result_window, true);
  } else if (s_result_text) {
    text_layer_set_text(s_result_text, s_result_buf);
  }
}

static void set_result(const char *msg, bool done) {
  set_result_buf(msg);
  if (s_result_text) {
    text_layer_set_text(s_result_text, s_result_buf);
  }
  if (done) {
    if (s_result_dismiss_timer) {
      app_timer_cancel(s_result_dismiss_timer);
    }
    uint32_t visible = (s_result_detail_ptr && s_result_detail_ptr[0])
                           ? RESULT_VISIBLE_LONG_MS
                           : RESULT_VISIBLE_MS;
    s_result_dismiss_timer = app_timer_register(visible, result_dismiss_cb, NULL);
  }
}

// ---------- send path ----------
static void clear_pending(void) {
  s_has_pending = false;
}

static void retry_cb(void *data) {
  s_retry_timer = NULL;
  try_send_pending();
}

static void schedule_retry(uint32_t ms) {
  if (++s_attempts > MAX_ATTEMPTS) {
    vibes_double_pulse();
    set_result("Failed", true);
    clear_pending();
    return;
  }
  if (s_retry_timer) {
    app_timer_cancel(s_retry_timer);
  }
  s_retry_timer = app_timer_register(ms, retry_cb, NULL);
}

static void ready_fallback_cb(void *data) {
  s_ready_fallback_timer = NULL;
  if (s_has_pending && !s_js_ready) {
    s_js_ready = true; // pkjs is almost certainly up; avoid stalling if JS_READY was lost
    try_send_pending();
  }
}

static void try_send_pending(void) {
  if (!s_has_pending) {
    return;
  }
  if (!s_js_ready) {
    set_result("Connecting...", false);
    if (!s_ready_fallback_timer) {
      s_ready_fallback_timer = app_timer_register(READY_FALLBACK_MS, ready_fallback_cb, NULL);
    }
    return;
  }
  DictionaryIterator *iter;
  AppMessageResult r = app_message_outbox_begin(&iter);
  if (r != APP_MSG_OK) {
    if (r == APP_MSG_BUSY) {
      set_result("Sending...", false);
      schedule_retry(BUSY_RETRY_MS);
    } else {
      set_result("Send error", true);
      clear_pending();
    }
    return;
  }
  dict_write_cstring(iter, s_pending_key, s_pending_text);
  dict_write_uint32(iter, MESSAGE_KEY_SEQ, ++s_seq);
  dict_write_end(iter);
  app_message_outbox_send();
}

static void request_capture(uint32_t key, const char *text) {
  strncpy(s_pending_text, text, sizeof(s_pending_text) - 1);
  s_pending_text[sizeof(s_pending_text) - 1] = '\0';
  s_pending_key = key;
  s_has_pending = true;
  s_attempts = 0;
  show_result_window("Sending...");
  set_result_detail(s_pending_text); // show what we captured while it sends
  try_send_pending();
}

// ---------- AppMessage handlers ----------
static void ack_watchdog_cb(void *data) {
  s_ack_timer = NULL;
  set_result("No reply", true);
}

static void inbox_received_handler(DictionaryIterator *iter, void *context) {
  Tuple *ql = dict_find(iter, MESSAGE_KEY_QUICK_LOGS);
  if (ql) {
    apply_quick_logs(ql->value->cstring);
    if (s_menu_layer) {
      menu_layer_reload_data(s_menu_layer);
    }
  }

  if (dict_find(iter, MESSAGE_KEY_JS_READY)) {
    s_js_ready = true;
    if (s_ready_fallback_timer) {
      app_timer_cancel(s_ready_fallback_timer);
      s_ready_fallback_timer = NULL;
    }
    try_send_pending();
  }

  // Note: ACKs are not matched to SEQ on this side — with one capture in
  // flight at a time the correlation is implicit; a crossed ACK is a brief
  // cosmetic mismatch at worst.
  Tuple *ack = dict_find(iter, MESSAGE_KEY_ACK_STATUS);
  if (ack) {
    if (s_ack_timer) {
      app_timer_cancel(s_ack_timer);
      s_ack_timer = NULL;
    }
    const char *status = ack->value->cstring;
    if (strcmp(status, "ok") == 0) {
      vibes_short_pulse();
      set_result("Saved", true);
    } else if (strcmp(status, "queued") == 0) {
      vibes_short_pulse();
      set_result("Queued (offline)", true);
    } else {
      char tmp[64];
      vibes_double_pulse();
      snprintf(tmp, sizeof(tmp), "Failed: %s", status);
      set_result(tmp, true);
    }
  }
}

static void inbox_dropped_handler(AppMessageResult reason, void *context) {
  // A phone->watch message was lost. The ACK watchdog covers a lost ACK; a lost
  // QUICK_LOGS list just means the menu keeps its current contents.
}

static void outbox_sent_handler(DictionaryIterator *iter, void *context) {
  clear_pending();
  set_result("Saving...", false);
  if (s_ack_timer) {
    app_timer_cancel(s_ack_timer);
  }
  s_ack_timer = app_timer_register(ACK_WATCHDOG_MS, ack_watchdog_cb, NULL);
}

static void outbox_failed_handler(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  if (s_has_pending &&
      (reason == APP_MSG_APP_NOT_RUNNING || reason == APP_MSG_NOT_CONNECTED ||
       reason == APP_MSG_SEND_TIMEOUT || reason == APP_MSG_SEND_REJECTED)) {
    set_result("Retrying...", false);
    schedule_retry(SEND_RETRY_MS);
    return;
  }
  vibes_double_pulse();
  set_result("Phone unreachable", true);
  clear_pending();
}

// ---------- chained dictation ----------
#if defined(PBL_MICROPHONE)
static void configure_dictation(void) {
  if (s_dictation_session) {
    dictation_session_enable_confirmation(s_dictation_session, false);
    dictation_session_enable_error_dialogs(s_dictation_session, true);
  }
}

static void append_leg(const char *text) {
  size_t tlen = strlen(text);
  size_t sep = s_accum_len ? 1 : 0;
  size_t room = (s_text_budget > s_accum_len + sep)
                    ? s_text_budget - s_accum_len - sep
                    : 0;
  if (tlen > room) {
    tlen = room;
  }
  if (tlen == 0) {
    return;
  }
  if (sep) {
    s_accum[s_accum_len++] = ' ';
  }
  memcpy(s_accum + s_accum_len, text, tlen);
  s_accum_len += tlen;
  s_accum[s_accum_len] = '\0';
}

static void finish_voice_capture(void) {
  if (s_accum_len) {
    request_capture(MESSAGE_KEY_CAPTURE_VOICE, s_accum);
  }
}

static void dictation_status_callback(DictationSession *session, DictationSessionStatus status,
                                      char *transcription, void *context) {
  if (status == DictationSessionStatusSuccess) {
    uint64_t elapsed = now_ms() - s_leg_start_ms;
    append_leg(transcription);
    bool nearly_full = s_accum_len + 16 >= s_text_budget;
    if (elapsed >= AUTO_CONTINUE_MS && !nearly_full) {
      // The firmware cap ended this leg, not the speaker — keep listening.
      start_voice_leg();
      return;
    }
    finish_voice_capture();
    return;
  }

  // Recreate a stale session (revival-era Pebble Time 2 dictation bug).
  if (status == DictationSessionStatusFailureInternalError ||
      status == DictationSessionStatusFailureDisabled) {
    dictation_session_destroy(s_dictation_session);
    s_dictation_session = dictation_session_create(DICTATION_BUFFER_SIZE,
                                                   dictation_status_callback, NULL);
    configure_dictation();
  }

  if (s_accum_len) {
    // Mid-chain stop (silence, BACK, or an error after real content): the riff
    // is over — send what we have. Inbox philosophy: capture beats discard.
    finish_voice_capture();
    return;
  }
  if (status == DictationSessionStatusFailureTranscriptionRejected ||
      status == DictationSessionStatusFailureTranscriptionRejectedWithError) {
    return; // backed out before saying anything — quiet cancel, menu remains
  }
  set_result_detail(NULL);
  show_result_window("No transcript");
  set_result("No transcript", true);
}
#endif

static void start_voice_leg(void) {
#if defined(PBL_MICROPHONE)
  if (s_dictation_session) {
    s_leg_start_ms = now_ms();
    dictation_session_start(s_dictation_session);
    return;
  }
#endif
  set_result_detail(NULL);
  show_result_window("No microphone");
  set_result("No microphone", true);
}

static void begin_voice_capture(void) {
  s_accum_len = 0;
  s_accum[0] = '\0';
  start_voice_leg();
}

// ---------- menu (dynamic) ----------
static int quick_log_row(int row) {
  return s_has_voice_item ? row - 1 : row;
}

static uint16_t menu_total_rows(void) {
  uint16_t n = (s_has_voice_item ? 1 : 0) + s_log_count;
  return n > 0 ? n : 1; // a lone hint row when there's nothing else
}

static bool menu_is_hint_row(void) {
  return (s_has_voice_item ? 1 : 0) + s_log_count == 0;
}

static uint16_t menu_get_num_rows(MenuLayer *ml, uint16_t section, void *ctx) {
  return menu_total_rows();
}

static int16_t menu_get_header_height(MenuLayer *ml, uint16_t section, void *ctx) {
  return MENU_CELL_BASIC_HEADER_HEIGHT;
}

static void menu_draw_header(GContext *gctx, const Layer *cell_layer, uint16_t section, void *ctx) {
  menu_cell_basic_header_draw(gctx, cell_layer, "Capture");
}

static void menu_draw_row(GContext *gctx, const Layer *cell_layer, MenuIndex *cell_index, void *ctx) {
  if (menu_is_hint_row()) {
    menu_cell_basic_draw(gctx, cell_layer, "Add quick-logs", "Pebble app > Settings", NULL);
    return;
  }
  int row = cell_index->row;
  if (s_has_voice_item && row == 0) {
    menu_cell_basic_draw(gctx, cell_layer, "Voice note", "Speak; pause to send", NULL);
    return;
  }
  int li = quick_log_row(row);
  if (li >= 0 && li < s_log_count) {
    menu_cell_basic_draw(gctx, cell_layer, s_logs[li].label, NULL, NULL);
  }
}

static void menu_select(MenuLayer *ml, MenuIndex *cell_index, void *ctx) {
  if (menu_is_hint_row()) {
    return;
  }
  int row = cell_index->row;
  if (s_has_voice_item && row == 0) {
    begin_voice_capture();
    return;
  }
  int li = quick_log_row(row);
  if (li >= 0 && li < s_log_count) {
    set_result_detail(NULL);
    request_capture(MESSAGE_KEY_CAPTURE_TEXT, s_logs[li].text);
  }
}

static void menu_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  s_menu_layer = menu_layer_create(b);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){
    .get_num_rows = menu_get_num_rows,
    .get_header_height = menu_get_header_height,
    .draw_header = menu_draw_header,
    .draw_row = menu_draw_row,
    .select_click = menu_select,
  });
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
  layer_add_child(root, menu_layer_get_layer(s_menu_layer));
}

static void menu_window_unload(Window *window) {
  if (s_menu_layer) {
    menu_layer_destroy(s_menu_layer);
    s_menu_layer = NULL;
  }
}

// ---------- app lifecycle ----------
static void init(void) {
  apply_quick_logs(NULL); // none until the phone pushes a configured list

  // Seed SEQ from wall-clock so it stays monotonic across app launches —
  // a per-launch counter restarting at 1 would collide with pkjs's
  // already-seen dedupe and get fresh captures swallowed as duplicates.
  s_seq = (uint32_t)time(NULL);

#if defined(PBL_MICROPHONE)
  s_has_voice_item = true;
#else
  s_has_voice_item = false;
#endif

  app_message_register_inbox_received(inbox_received_handler);
  app_message_register_inbox_dropped(inbox_dropped_handler);
  app_message_register_outbox_sent(outbox_sent_handler);
  app_message_register_outbox_failed(outbox_failed_handler);

  // Negotiate an outbox big enough for a stitched multi-leg note; clamp the
  // text budget to whatever the firmware actually grants.
  uint32_t outbox = ACCUM_TEXT_MAX + 128;
  uint32_t outbox_max = app_message_outbox_size_maximum();
  if (outbox > outbox_max) {
    outbox = outbox_max;
  }
  app_message_open(INBOX_SIZE, outbox);
  s_text_budget = (outbox > 192) ? outbox - 128 : 64;
  if (s_text_budget > ACCUM_TEXT_MAX - 1) {
    s_text_budget = ACCUM_TEXT_MAX - 1;
  }

#if defined(PBL_MICROPHONE)
  s_dictation_session = dictation_session_create(DICTATION_BUFFER_SIZE,
                                                 dictation_status_callback, NULL);
  configure_dictation();
#endif

  s_menu_window = window_create();
  window_set_window_handlers(s_menu_window, (WindowHandlers){
    .load = menu_window_load,
    .unload = menu_window_unload,
  });
  window_stack_push(s_menu_window, true);

  // Voice-first: open the app and it's already listening. BACK lands on the
  // menu underneath.
#if defined(PBL_MICROPHONE)
  if (s_dictation_session) {
    begin_voice_capture();
  }
#endif
}

static void deinit(void) {
#if defined(PBL_MICROPHONE)
  if (s_dictation_session) {
    dictation_session_destroy(s_dictation_session);
  }
#endif
  if (s_menu_window) {
    window_destroy(s_menu_window);
  }
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
