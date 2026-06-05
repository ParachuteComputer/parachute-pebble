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

// The "Sign in with your hub" button on the gear page hands pkjs an
// {action:"oauth"} payload and the NATIVE flow below does everything — see the
// "native OAuth sign-in" section. No hosted pages are involved.

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

// ---- event trail (last 12 events, readable on the gear page) ----
function logEvent(msg) {
  try {
    var ev = JSON.parse(localStorage.getItem("pc_events") || "[]");
    ev.push(new Date().toISOString().slice(11, 19) + " " + msg);
    while (ev.length > 12) ev.shift();
    localStorage.setItem("pc_events", JSON.stringify(ev));
  } catch (e) {}
}
function loadEvents() {
  try {
    return JSON.parse(localStorage.getItem("pc_events") || "[]");
  } catch (e) {
    return [];
  }
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
// In-memory ONLY: redelivery can only happen within one watchapp session, and
// persisting this set caused fresh captures after an app relaunch to be
// swallowed as "duplicates" when the watch's counter restarted.
var seenSeqs = [];
function alreadySeen(seq) {
  return seq > 0 && seenSeqs.indexOf(seq) !== -1;
}
function markSeen(seq) {
  if (!seq) return;
  // 30-entry window; SEQ is wall-clock-seeded on the watch, so cross-session
  // collision would need a relaunch + capture in the same epoch second — moot.
  seenSeqs.push(seq);
  while (seenSeqs.length > 30) seenSeqs.shift();
}

// OAuth refresh (tokens delivered by the hub's pebble-config page). Rotates
// the refresh token when the hub returns a new one.
function tryRefresh(cb) {
  var rt = getCfg("refresh_token", "");
  var te = getCfg("token_endpoint", "");
  var cid = getCfg("client_id", "");
  if (!rt || !te || !cid) {
    cb(false);
    return;
  }
  var xhr = new XMLHttpRequest();
  xhr.open("POST", te, true);
  xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
  xhr.timeout = 15000;
  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        var r = JSON.parse(xhr.responseText);
        if (r.access_token) setCfg("token", r.access_token);
        if (r.refresh_token) setCfg("refresh_token", r.refresh_token);
        logEvent("token refreshed");
        cb(true);
        return;
      } catch (e) {
        logEvent("refresh failed: unexpected response");
        cb(false);
        return;
      }
    }
    logEvent("refresh failed: http " + xhr.status);
    cb(false);
  };
  xhr.onerror = function () {
    logEvent("refresh failed: network");
    cb(false);
  };
  xhr.ontimeout = function () {
    logEvent("refresh failed: timeout");
    cb(false);
  };
  xhr.send(
    "grant_type=refresh_token&refresh_token=" + encodeURIComponent(rt) +
    "&client_id=" + encodeURIComponent(cid)
  );
}

function postNote(item, cb, isRetry) {
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
    if (xhr.status >= 200 && xhr.status < 300) {
      logEvent("posted " + item.kind + " (" + item.text.length + " ch)");
      cb(null);
    } else if (xhr.status === 401 && !isRetry) {
      // expired access token — refresh and retry once
      tryRefresh(function (ok) {
        if (ok) {
          postNote(item, cb, true);
        } else {
          logEvent("post 401, refresh unavailable");
          cb("http 401");
        }
      });
    } else {
      logEvent("post failed: http " + xhr.status);
      cb("http " + xhr.status);
    }
  };
  xhr.onerror = function () {
    logEvent("post failed: network");
    cb("network");
  };
  xhr.ontimeout = function () {
    logEvent("post failed: timeout");
    cb("timeout");
  };
  xhr.send(body);
}

// Permanent failures will never succeed on retry; queued items carrying them
// must be dropped or they block the whole line forever. 401 is NOT permanent
// (re-auth heals it); neither are 408/429.
function isPermanentError(err) {
  return /^http 4\d\d$/.test(err) && err !== "http 401" && err !== "http 408" && err !== "http 429";
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
    } else if (isPermanentError(err)) {
      var cur2 = loadQueue();
      var dropped = cur2.shift();
      saveQueue(cur2);
      logEvent("DROPPED queued " + (dropped && dropped.kind) + ": " + err);
      flushQueue(); // a poisoned item must not block the line
    }
    // transient: stop; we'll retry on the next ready/capture/config event
  });
}

function ack(status, seq) {
  Pebble.sendAppMessage({ ACK_STATUS: status, SEQ: seq || 0 });
}

function handleCapture(kind, text, seq) {
  logEvent("capture " + kind + " seq " + seq);
  if (alreadySeen(seq)) {
    logEvent("dup seq " + seq + " — re-acked, not re-posted");
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
      // TODO: a PERMANENT error lands here too — the watch shows "Queued" but
      // the item will be dropped (with an event-trail entry) on the next
      // flush. Rare (malformed payload / firmware bug); acceptable for now.
      enqueue(item);
      ack("queued", seq);
    }
  });
}

Pebble.addEventListener("ready", function () {
  try {
    localStorage.removeItem("pc_seen"); // stale persisted dedupe state from <=v0.1
  } catch (e) {}
  // One message: unblock the watch's send gate AND push config (quick-logs +
  // voice mode).
  var msg = { JS_READY: 1, VOICE_MODE: getCfg("voicemode", "0") === "1" ? 1 : 0 };
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


// ---- native OAuth sign-in (RFC 8252: no hosted pages anywhere) ----
// The gear page hands us {action:"oauth", hub, ...}; we discover the hub's
// auth server, register ourselves (DCR; first time lands "pending" and the
// hub shows its approve-once page right in the sign-in webview), build a
// PKCE challenge, and open the hub's own consent. The hub redirects to
// pebblejs://close#code=...&state=... (response_mode=fragment — the only
// form the phone app delivers; query-form params are dropped), which lands
// in webviewclosed below, and we exchange the code over XHR.

// Pure-JS SHA-256 (FIPS 180-4) for PKCE S256 — pkjs has no WebCrypto.
// Verified byte-identical to node:crypto across pad-boundary vectors.
function sha256Bytes(bytes) {
  var K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var bitLen = bytes.length * 8;
  var padded = bytes.slice();
  padded.push(0x80);
  while (padded.length % 64 !== 56) padded.push(0);
  padded.push(0, 0, 0, 0,
    (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);
  var w = new Array(64);
  for (var i = 0; i < padded.length; i += 64) {
    for (var t = 0; t < 16; t++) {
      w[t] = (padded[i+t*4] << 24) | (padded[i+t*4+1] << 16) | (padded[i+t*4+2] << 8) | padded[i+t*4+3];
    }
    for (t = 16; t < 64; t++) {
      var s0 = ((w[t-15]>>>7)|(w[t-15]<<25)) ^ ((w[t-15]>>>18)|(w[t-15]<<14)) ^ (w[t-15]>>>3);
      var s1 = ((w[t-2]>>>17)|(w[t-2]<<15)) ^ ((w[t-2]>>>19)|(w[t-2]<<13)) ^ (w[t-2]>>>10);
      w[t] = (w[t-16] + s0 + w[t-7] + s1) | 0;
    }
    var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for (t = 0; t < 64; t++) {
      var S1 = ((e>>>6)|(e<<26)) ^ ((e>>>11)|(e<<21)) ^ ((e>>>25)|(e<<7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K[t] + w[t]) | 0;
      var S0 = ((a>>>2)|(a<<30)) ^ ((a>>>13)|(a<<19)) ^ ((a>>>22)|(a<<10));
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) | 0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
    H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
  }
  var out = [];
  for (var j = 0; j < 8; j++) {
    out.push((H[j]>>>24)&0xff, (H[j]>>>16)&0xff, (H[j]>>>8)&0xff, H[j]&0xff);
  }
  return out;
}

var B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function b64url(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i+1] : null, b2 = i + 2 < bytes.length ? bytes[i+2] : null;
    out += B64URL.charAt(b0 >> 2);
    out += B64URL.charAt(((b0 & 3) << 4) | (b1 === null ? 0 : b1 >> 4));
    if (b1 !== null) out += B64URL.charAt(((b1 & 15) << 2) | (b2 === null ? 0 : b2 >> 6));
    if (b2 !== null) out += B64URL.charAt(b2 & 63);
  }
  return out;
}

function asciiBytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0xff);
  return out;
}

// crypto.getRandomValues when the runtime has it; otherwise a mixed fallback.
// (PKCE still binds the code to this session; hub codes are single-use,
// short-TTL, and consent-gated — acceptable for the fallback path.)
function randomBytes(n) {
  try {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      var arr = new Uint8Array(n);
      crypto.getRandomValues(arr);
      var out = [];
      for (var i = 0; i < n; i++) out.push(arr[i]);
      return out;
    }
  } catch (e) {}
  logEvent("note: weak-entropy fallback for PKCE");
  var out2 = [];
  for (var j = 0; j < n; j++) {
    out2.push((Math.floor(Math.random() * 256) ^ (Date.now() >> (j % 8)) ^ (j * 97)) & 0xff);
  }
  return out2;
}

function normalizeHub(raw) {
  var h = String(raw || "").trim().replace(/\/+$/, "");
  if (h && !/^https?:\/\//.test(h)) h = "https://" + h;
  return h;
}

function xhrJson(method, url, body, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open(method, url, true);
  xhr.setRequestHeader("Accept", "application/json");
  if (body) xhr.setRequestHeader("Content-Type", "application/json");
  xhr.timeout = 15000;
  xhr.onload = function () {
    var data = null;
    try { data = JSON.parse(xhr.responseText); } catch (e) {}
    cb(xhr.status >= 200 && xhr.status < 300 ? null : "http " + xhr.status, data);
  };
  xhr.onerror = function () { cb("network", null); };
  xhr.ontimeout = function () { cb("timeout", null); };
  xhr.send(body ? JSON.stringify(body) : null);
}

var REDIRECT = "pebblejs://close";

function beginNativeSignIn(hubRaw, vault) {
  var hub = normalizeHub(hubRaw);
  if (!hub) { logEvent("sign-in: no hub origin"); return; }
  logEvent("sign-in: discovering " + hub);
  xhrJson("GET", hub + "/.well-known/oauth-authorization-server", null, function (err, meta) {
    if (err || !meta || !meta.authorization_endpoint || !meta.token_endpoint || !meta.registration_endpoint) {
      logEvent("sign-in: discovery failed (" + (err || "bad metadata") + ")");
      return;
    }
    var issuer = meta.issuer || hub;
    var cachedCid = null;
    try { cachedCid = localStorage.getItem("pc_dcr_cid:" + issuer); } catch (e) {}
    function withClient(cid) {
      var verifier = b64url(randomBytes(32));
      var stateNonce = b64url(randomBytes(16));
      var challenge = b64url(sha256Bytes(asciiBytes(verifier)));
      try {
        localStorage.setItem("pc_oauth_pending", JSON.stringify({
          v: verifier, s: stateNonce, cid: cid, te: meta.token_endpoint,
          iss: issuer, hub: hub, vault: vault || "default", at: Date.now()
        }));
      } catch (e) { logEvent("sign-in: cannot persist state"); return; }
      var u = meta.authorization_endpoint +
        "?client_id=" + encodeURIComponent(cid) +
        "&redirect_uri=" + encodeURIComponent(REDIRECT) +
        "&response_type=code" +
        "&scope=" + encodeURIComponent("vault:" + (vault || "default") + ":write") +
        "&state=" + encodeURIComponent(stateNonce) +
        "&code_challenge=" + challenge +
        "&code_challenge_method=S256" +
        "&response_mode=fragment";
      logEvent("sign-in: opening hub consent");
      Pebble.openURL(u);
    }
    if (cachedCid) { withClient(cachedCid); return; }
    xhrJson("POST", meta.registration_endpoint, {
      client_name: "Parachute Pebble",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    }, function (rerr, reg) {
      if (rerr || !reg || !reg.client_id) {
        logEvent("sign-in: registration failed (" + (rerr || "no client_id") + ")");
        return;
      }
      try { localStorage.setItem("pc_dcr_cid:" + issuer, reg.client_id); } catch (e) {}
      withClient(reg.client_id);
    });
  });
}

function completeNativeSignIn(params) {
  var pending = null;
  try { pending = JSON.parse(localStorage.getItem("pc_oauth_pending") || "null"); } catch (e) {}
  if (!pending) { logEvent("sign-in: code arrived with no pending state"); return; }
  if (Date.now() - pending.at > 10 * 60 * 1000) { logEvent("sign-in: stale state, retry"); return; }
  if (params.state !== pending.s) { logEvent("sign-in: state mismatch"); return; }
  var xhr = new XMLHttpRequest();
  xhr.open("POST", pending.te, true);
  xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
  xhr.timeout = 15000;
  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        var tok = JSON.parse(xhr.responseText);
        if (!tok.access_token) throw new Error("no access_token");
        setCfg("hub", pending.hub);
        setCfg("vault", pending.vault);
        setCfg("token", tok.access_token);
        if (tok.refresh_token) setCfg("refresh_token", tok.refresh_token);
        setCfg("token_endpoint", pending.te);
        setCfg("client_id", pending.cid);
        try { localStorage.removeItem("pc_oauth_pending"); } catch (e) {}
        logEvent("signed in (native OAuth)");
        flushQueue();
        return;
      } catch (e) {
        logEvent("sign-in: bad token response");
        return;
      }
    }
    logEvent("sign-in: exchange failed http " + xhr.status);
  };
  xhr.onerror = function () { logEvent("sign-in: exchange network error"); };
  xhr.ontimeout = function () { logEvent("sign-in: exchange timeout"); };
  xhr.send(
    "grant_type=authorization_code" +
    "&code=" + encodeURIComponent(params.code) +
    "&redirect_uri=" + encodeURIComponent(REDIRECT) +
    "&client_id=" + encodeURIComponent(pending.cid) +
    "&code_verifier=" + encodeURIComponent(pending.v)
  );
}

function parseQueryish(str) {
  var out = {};
  var parts = String(str || "").split("&");
  for (var i = 0; i < parts.length; i++) {
    var eq = parts[i].indexOf("=");
    if (eq < 0) continue;
    var k = parts[i].slice(0, eq);
    var v = parts[i].slice(eq + 1);
    try { v = decodeURIComponent(v); } catch (e) {}
    out[k] = v;
  }
  return out;
}

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
    '<label>Voice mode</label><select id="vm">' +
    '<option value="0"' + (getCfg("voicemode", "0") !== "1" ? " selected" : "") + ">Send on pause</option>" +
    '<option value="1"' + (getCfg("voicemode", "0") === "1" ? " selected" : "") + ">Continuous (BACK or silence to send)</option>" +
    "</select>" +
    '<button id="oauth" style="background:#34c759">Sign in with your hub (OAuth)</button>' +
    '<div class="hint">Uses the hub origin above; replaces the pasted token with auto-renewing sign-in.</div>' +
    "<label>Recent activity</label><pre style=\"font-size:11px;background:#fff;border:1px solid #d2d2d7;border-radius:9px;padding:8px;white-space:pre-wrap\">" +
    escArea(loadEvents().join("\n") || "(no events yet)") + "</pre>" +
    '<button id="save">Save</button><script>' +
    "function qp(n){var m=new RegExp('[?&]'+n+'=([^&]*)').exec(location.search);return m?decodeURIComponent(m[1]):''}" +
    "var rt=qp('return_to')||'pebblejs://close#';" +
    "document.getElementById('save').addEventListener('click',function(){" +
    "var ql=document.getElementById('ql').value.split('\\n').map(function(l){var i=l.indexOf('|');if(i<0)return null;" +
    "var a=l.slice(0,i).trim(),b=l.slice(i+1).trim();return a&&b?{label:a,text:b}:null}).filter(Boolean);" +
    "var out={hub:document.getElementById('hub').value.trim()," +
    "vault:document.getElementById('vault').value.trim()||'default'," +
    "token:document.getElementById('token').value.trim()," +
    "voicemode:document.getElementById('vm').value,quicklogs:ql};" +
    "document.location=rt+encodeURIComponent(JSON.stringify(out))});" +
    "document.getElementById('oauth').addEventListener('click',function(){" +
    "var hub=document.getElementById('hub').value.trim().replace(/\\/+$/,'');" +
    "if(!hub){alert('Enter your hub origin first');return}" +
    "var ql=document.getElementById('ql').value.split('\\n').map(function(l){var i=l.indexOf('|');if(i<0)return null;" +
    "var a=l.slice(0,i).trim(),b=l.slice(i+1).trim();return a&&b?{label:a,text:b}:null}).filter(Boolean);" +
    "var out={action:'oauth',hub:hub,vault:document.getElementById('vault').value.trim()||'default'," +
    "voicemode:document.getElementById('vm').value,quicklogs:ql};" +
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
  // Three shapes arrive here: (a) the gear page's JSON payloads (config saves
  // and the {action:"oauth"} hand-off), (b) the hub's OAuth redirect fragment
  // "code=...&state=..." (the in-app webview path delivers it URL-decoded;
  // the deep-link path raw — both parse the same), (c) garbage.
  try {
    var probe = JSON.parse(decodeURIComponent(e.response));
    if (probe && probe.action === "oauth") {
      // store the non-auth config now so it isn't lost if sign-in is abandoned
      if (probe.hub !== undefined) setCfg("hub", probe.hub);
      if (probe.vault !== undefined) setCfg("vault", probe.vault);
      if (probe.voicemode !== undefined) setCfg("voicemode", String(probe.voicemode));
      if (probe.quicklogs !== undefined) setCfg("quicklogs", JSON.stringify(probe.quicklogs));
      beginNativeSignIn(probe.hub, probe.vault);
      return;
    }
  } catch (probeErr) {
    var params = parseQueryish(e.response.replace(/^[#?]/, ""));
    if (params.code && params.state) {
      completeNativeSignIn(params);
      return;
    }
    if (params.error) {
      logEvent("sign-in: hub returned " + params.error);
      if (params.error === "invalid_client") {
        // cached client_id is stale (hub registry rebuilt) — drop it so the
        // next sign-in attempt re-registers instead of dead-ending
        try {
          var stale = JSON.parse(localStorage.getItem("pc_oauth_pending") || "null");
          if (stale && stale.iss) localStorage.removeItem("pc_dcr_cid:" + stale.iss);
        } catch (e2) {}
      }
      return;
    }
    return; // unrecognized response
  }
  try {
    var cfg = JSON.parse(decodeURIComponent(e.response));
    if (cfg.hub !== undefined) setCfg("hub", cfg.hub);
    if (cfg.vault !== undefined) setCfg("vault", cfg.vault);
    if (cfg.token !== undefined && cfg.token !== "") setCfg("token", cfg.token);
    if (cfg.refresh_token !== undefined && cfg.refresh_token !== "") setCfg("refresh_token", cfg.refresh_token);
    if (cfg.token_endpoint !== undefined && cfg.token_endpoint !== "") setCfg("token_endpoint", cfg.token_endpoint);
    if (cfg.client_id !== undefined && cfg.client_id !== "") setCfg("client_id", cfg.client_id);
    if (cfg.voicemode !== undefined) setCfg("voicemode", String(cfg.voicemode));
    if (cfg.quicklogs !== undefined) setCfg("quicklogs", JSON.stringify(cfg.quicklogs));
    logEvent("config saved" + (cfg.refresh_token ? " (OAuth)" : ""));
    // push updated config to the watch in one message
    var m = { VOICE_MODE: getCfg("voicemode", "0") === "1" ? 1 : 0 };
    var qls = quickLogsString();
    if (qls) m.QUICK_LOGS = qls;
    Pebble.sendAppMessage(m);
    flushQueue();
  } catch (err) {}
});
