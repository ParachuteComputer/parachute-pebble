/* Parachute Pebble — phone side (PebbleKit JS).
 *
 * Runs in the Pebble mobile app on your phone. The watch hands captures here
 * over AppMessage; this code does the HTTP POST to your Parachute vault, because
 * the watch itself has no internet. It announces readiness (JS_READY), pushes
 * the configurable quick-logs list to the watch (QUICK_LOGS), dedupes
 * redelivered captures by SEQ, and queues captures offline, flushing one-at-a-
 * time when the vault is reachable again.
 *
 * Capture contract (the same one notes-ui writes):
 *   POST <hub>/vault/<vault>/api/notes
 *   Authorization: Bearer <token>
 *   { content, path, tags: ["capture","capture/voice"|"capture/text"], metadata }
 */

// ---- v0 fallback config: fill these in, OR set everything via the gear page ----
var DEFAULT_HUB = ""; // e.g. "https://your-tunnel.example.com" — phone-reachable hub origin, no trailing slash
var DEFAULT_VAULT = "default";
var DEFAULT_TOKEN = ""; // mint with: parachute auth mint-token --scope vault:default:write
// CONFIG_URL: leave "" to use the built-in (no-hosting) config page. Set it to a
// hosted copy of config/index.html if your phone's Pebble app won't open data: URLs.
var CONFIG_URL = "";

// ---- tiny config store (localStorage, per-app-UUID, survives reinstall) ----
function getCfg(key, dflt) {
  try {
    var v = localStorage.getItem("pc_" + key);
    return v === null || v === "" ? dflt : v;
  } catch (e) {
    return dflt;
  }
}
function setCfg(key, val) {
  try {
    localStorage.setItem("pc_" + key, val);
  } catch (e) {}
}

function pad(n) {
  return (n < 10 ? "0" : "") + n;
}

// Match the vault path conventions notes-ui uses: text -> Notes/, voice -> Memos/.
function capturePath(kind, d) {
  var base = kind === "voice" ? "Memos" : "Notes";
  return (
    base + "/" + d.getFullYear() + "/" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "/" + pad(d.getHours()) + "-" + pad(d.getMinutes()) + "-" + pad(d.getSeconds())
  );
}

// ---- quick-logs (configurable; pushed to the watch) ----
function loadQuickLogs() {
  try {
    return JSON.parse(localStorage.getItem("pc_quicklogs") || "[]");
  } catch (e) {
    return [];
  }
}
// Encode for the watch as "Label | text" lines, capped to fit the AppMessage inbox.
function quickLogsString() {
  var arr = loadQuickLogs();
  var lines = [];
  for (var i = 0; i < arr.length && i < 10; i++) {
    var lbl = (arr[i].label || "").replace(/[\n|]/g, " ").slice(0, 27).trim();
    var txt = (arr[i].text || "").replace(/[\n|]/g, " ").slice(0, 79).trim();
    if (lbl && txt) lines.push(lbl + " | " + txt);
  }
  return lines.join("\n").slice(0, 600);
}
function sendQuickLogs() {
  var s = quickLogsString();
  if (s) Pebble.sendAppMessage({ QUICK_LOGS: s });
}

// ---- offline queue ----
function loadQueue() {
  try {
    return JSON.parse(localStorage.getItem("pc_queue") || "[]");
  } catch (e) {
    return [];
  }
}
function saveQueue(q) {
  try {
    localStorage.setItem("pc_queue", JSON.stringify(q));
  } catch (e) {}
}
function enqueue(item) {
  var q = loadQueue();
  q.push(item);
  saveQueue(q);
}

// ---- SEQ dedupe (a BUSY-retry can redeliver the same capture) ----
function loadSeen() {
  try {
    return JSON.parse(localStorage.getItem("pc_seen") || "[]");
  } catch (e) {
    return [];
  }
}
function alreadySeen(seq) {
  return seq > 0 && loadSeen().indexOf(seq) !== -1;
}
function markSeen(seq) {
  if (!seq) return;
  var s = loadSeen();
  s.push(seq);
  while (s.length > 30) s.shift();
  try {
    localStorage.setItem("pc_seen", JSON.stringify(s));
  } catch (e) {}
}

function postNote(item, cb) {
  var hub = getCfg("hub", DEFAULT_HUB).replace(/\/+$/, "");
  var vault = getCfg("vault", DEFAULT_VAULT);
  var token = getCfg("token", DEFAULT_TOKEN);
  if (!hub || !token) {
    cb("not configured");
    return;
  }
  var tags = item.kind === "voice" ? ["capture", "capture/voice"] : ["capture", "capture/text"];
  var body = JSON.stringify({
    content: item.text,
    path: item.path,
    tags: tags,
    metadata: { source: "pebble", device: "pebble-time-2", captured_at: item.at },
  });
  var xhr = new XMLHttpRequest();
  xhr.open("POST", hub + "/vault/" + vault + "/api/notes", true);
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.setRequestHeader("Authorization", "Bearer " + token);
  xhr.setRequestHeader("Accept", "application/json");
  xhr.timeout = 15000;
  xhr.onload = function () {
    cb(xhr.status >= 200 && xhr.status < 300 ? null : "http " + xhr.status);
  };
  xhr.onerror = function () {
    cb("network");
  };
  xhr.ontimeout = function () {
    cb("timeout");
  };
  xhr.send(body);
}

// Drain the queue one at a time; stop on the first failure. Guarded so a
// ready-event flush can't race an appmessage-triggered flush.
var flushing = false;
function flushQueue() {
  if (flushing) return;
  var q = loadQueue();
  if (!q.length) return;
  flushing = true;
  postNote(q[0], function (err) {
    flushing = false;
    if (!err) {
      var cur = loadQueue();
      cur.shift();
      saveQueue(cur);
      flushQueue();
    }
  });
}

function ack(status, seq) {
  Pebble.sendAppMessage({ ACK_STATUS: status, SEQ: seq || 0 });
}

function handleCapture(kind, text, seq) {
  if (alreadySeen(seq)) {
    ack("ok", seq);
    return;
  }
  var d = new Date();
  var item = { kind: kind, text: text, path: capturePath(kind, d), at: d.toISOString() };
  postNote(item, function (err) {
    markSeen(seq);
    if (!err) {
      ack("ok", seq);
      flushQueue();
    } else {
      enqueue(item);
      ack("queued", seq);
    }
  });
}

Pebble.addEventListener("ready", function () {
  // One message: unblock the watch's send gate AND push the current quick-logs.
  var msg = { JS_READY: 1 };
  var ql = quickLogsString();
  if (ql) msg.QUICK_LOGS = ql;
  Pebble.sendAppMessage(msg);
  flushQueue();
});

Pebble.addEventListener("appmessage", function (e) {
  var p = e.payload || {};
  var seq = typeof p.SEQ === "number" ? p.SEQ : 0;
  if (typeof p.CAPTURE_VOICE === "string") {
    handleCapture("voice", p.CAPTURE_VOICE, seq);
  } else if (typeof p.CAPTURE_TEXT === "string") {
    handleCapture("text", p.CAPTURE_TEXT, seq);
  }
});

// ---- config page (hub/vault/token + quick-logs) ----
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escArea(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Built-in config page, opened as a data: URL so no hosting is needed. Current
// values are injected; Save posts {hub,vault,token,quicklogs} back to the app.
function buildConfigHtml() {
  var hub = getCfg("hub", DEFAULT_HUB);
  var vault = getCfg("vault", DEFAULT_VAULT);
  var token = getCfg("token", DEFAULT_TOKEN);
  var qlLines = loadQuickLogs()
    .map(function (q) {
      return (q.label || "") + " | " + (q.text || "");
    })
    .join("\n");
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Parachute Pebble</title><style>" +
    "body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:20px;background:#f5f5f7;color:#1d1d1f}" +
    "h1{font-size:19px;margin:0 0 16px}label{display:block;font-size:13px;font-weight:600;margin:14px 0 5px}" +
    "input,textarea{width:100%;box-sizing:border-box;padding:11px;font-size:16px;border:1px solid #d2d2d7;border-radius:9px;background:#fff}" +
    "textarea{font-family:ui-monospace,monospace;font-size:14px}" +
    ".hint{font-size:12px;color:#6e6e73;margin-top:4px}" +
    "button{width:100%;margin-top:22px;padding:14px;font-size:16px;font-weight:600;color:#fff;background:#0071e3;border:none;border-radius:12px}" +
    "code{background:#ececf0;padding:1px 4px;border-radius:4px}</style></head><body>" +
    "<h1>Parachute Pebble</h1>" +
    '<label>Hub origin</label><input id="hub" type="url" autocapitalize="off" autocorrect="off" value="' +
    esc(hub) + '">' +
    '<div class="hint">Your hub URL as your phone can reach it (the Cloudflare-tunnel URL).</div>' +
    '<label>Vault</label><input id="vault" type="text" autocapitalize="off" autocorrect="off" value="' +
    esc(vault) + '">' +
    '<label>Write token</label><input id="token" type="text" autocapitalize="off" autocorrect="off" value="' +
    esc(token) + '">' +
    '<div class="hint"><code>parachute auth mint-token --scope vault:default:write</code></div>' +
    '<label>Quick-logs (one per line: Label | note text)</label>' +
    '<textarea id="ql" rows="6" placeholder="Water | Drank water&#10;Meds | Took meds">' +
    escArea(qlLines) + "</textarea>" +
    '<div class="hint">Tap a label on the watch to save that note. Leave empty for voice-only.</div>' +
    '<button id="save">Save</button><script>' +
    "function qp(n){var m=new RegExp('[?&]'+n+'=([^&]*)').exec(location.search);return m?decodeURIComponent(m[1]):''}" +
    "var rt=qp('return_to')||'pebblejs://close#';" +
    "document.getElementById('save').addEventListener('click',function(){" +
    "var ql=document.getElementById('ql').value.split('\\n').map(function(l){var i=l.indexOf('|');if(i<0)return null;" +
    "var a=l.slice(0,i).trim(),b=l.slice(i+1).trim();return a&&b?{label:a,text:b}:null}).filter(Boolean);" +
    "var out={hub:document.getElementById('hub').value.trim()," +
    "vault:document.getElementById('vault').value.trim()||'default'," +
    "token:document.getElementById('token').value.trim(),quicklogs:ql};" +
    "document.location=rt+encodeURIComponent(JSON.stringify(out))});" +
    "</script></body></html>"
  );
}

Pebble.addEventListener("showConfiguration", function () {
  if (CONFIG_URL) {
    var current = encodeURIComponent(
      JSON.stringify({
        hub: getCfg("hub", DEFAULT_HUB),
        vault: getCfg("vault", DEFAULT_VAULT),
        token: getCfg("token", DEFAULT_TOKEN),
        quicklogs: loadQuickLogs(),
      })
    );
    Pebble.openURL(CONFIG_URL + "?current=" + current);
    return;
  }
  Pebble.openURL("data:text/html," + encodeURIComponent(buildConfigHtml()));
});

Pebble.addEventListener("webviewclosed", function (e) {
  if (!e || !e.response) {
    return;
  }
  try {
    var cfg = JSON.parse(decodeURIComponent(e.response));
    if (cfg.hub !== undefined) setCfg("hub", cfg.hub);
    if (cfg.vault !== undefined) setCfg("vault", cfg.vault);
    if (cfg.token !== undefined) setCfg("token", cfg.token);
    if (cfg.quicklogs !== undefined) setCfg("quicklogs", JSON.stringify(cfg.quicklogs));
    sendQuickLogs(); // push the updated list to the watch
    flushQueue();
  } catch (err) {}
});
