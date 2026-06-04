/**
 * Parachute Pebble setup page — the external-surface OAuth flow.
 *
 * This page is hosted on GitHub Pages (a foreign origin: github.io) and runs the
 * OAuth 2.1 + PKCE + Dynamic Client Registration dance against WHATEVER hub the
 * user enters. It replaces the old hub-hosted `pebble-config` surface so a stock
 * Parachute server (hub + vault only — no surface-host module) can still sign a
 * Pebble watch in. See README for the architecture note.
 *
 * Flow (ported from parachute-surface/packages/pebble-config/src/main.ts, which
 * went through two reviews — the contract below is identical):
 *
 *   1. The Pebble phone app opens its config webview, then redirects the browser
 *      here:
 *
 *        https://parachutecomputer.github.io/parachute-pebble/?return_to=<enc>&current=<enc-json>
 *
 *      `return_to` is the `pebblejs:` URL to navigate back to on Save (allowlisted
 *      to ONLY that scheme — the payload carries a vault write token + a rotating
 *      refresh token, so handing it to an arbitrary URL would be a credentialed
 *      open redirect). `current` is URL-encoded JSON {hub, vault, quicklogs} used
 *      to prefill the form.
 *
 *   2. The hub origin is PREFILLED from `current.hub` into an EDITABLE input —
 *      there is no tenancy meta tag on github.io, so the user confirms/types the
 *      hub their phone can reach. Clicking "Sign in" runs the OAuth dance
 *      (`beginOAuth` in ./oauth) against that hub: discover → DCR → PKCE authorize
 *      redirect.
 *
 *   3. The callback lands back on THIS same page (`?code=&state=`). We finish the
 *      token exchange, strip the params via replaceState, and show the quick-logs
 *      editor ("Label | note text" per line) prefilled from `current.quicklogs`.
 *
 *   4. Save navigates back to the Pebble app:
 *        return_to + encodeURIComponent(JSON.stringify(payload))
 *      with the exact {hub, vault, token, refresh_token, token_endpoint,
 *      client_id, quicklogs} payload the watch's webviewclosed handler consumes.
 */

import {
  InsecureContextError,
  PendingApprovalError,
  type PendingOAuthState,
  type TokenResponse,
  beginOAuth,
  completeOAuth,
  normalizeHubUrl,
} from "./oauth";

/** Default return target when the Pebble app didn't supply one (closes the webview). */
const DEFAULT_RETURN_TO = "pebblejs://close#";
/** sessionStorage keys that survive the OAuth redirect round-trip. */
const SS_RETURN_TO = "pebble_setup_return_to";
const SS_CURRENT = "pebble_setup_current";

/** A single Pebble quick-log button: a short label + the note text it writes. */
export interface QuickLog {
  label: string;
  text: string;
}

/** Prefill payload handed in via the `current` query param (all optional). */
export interface CurrentConfig {
  hub?: string;
  vault?: string;
  quicklogs?: QuickLog[];
}

/**
 * The payload handed BACK to the Pebble app on Save. The watch persists this and
 * uses `token` (+ `refresh_token` / `token_endpoint` / `client_id` to rotate it)
 * to write captures into `<hub>/vault/<vault>/api/notes`.
 */
export interface PebblePayload {
  hub: string;
  vault: string;
  token: string;
  refresh_token: string;
  token_endpoint: string;
  client_id: string;
  quicklogs: QuickLog[];
}

// ---------------------------------------------------------------------------
// Query-param + sessionStorage plumbing
// ---------------------------------------------------------------------------

/**
 * Parse the `current` query param (URL-encoded JSON). Tolerant: returns an empty
 * config on absence or any parse failure rather than throwing — a bad prefill
 * should never block the setup flow.
 */
export function parseCurrent(raw: string | null): CurrentConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as Record<string, unknown>;
    const out: CurrentConfig = {};
    if (typeof obj.hub === "string") out.hub = obj.hub;
    if (typeof obj.vault === "string") out.vault = obj.vault;
    if (Array.isArray(obj.quicklogs)) {
      out.quicklogs = obj.quicklogs
        .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
        .map((q) => ({
          label: typeof q.label === "string" ? q.label : "",
          text: typeof q.text === "string" ? q.text : "",
        }));
    }
    return out;
  } catch {
    return {};
  }
}

/** Serialize the quick-logs textarea (`Label | note text` per line) → array. */
export function parseQuickLogsText(text: string): QuickLog[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const sep = line.indexOf("|");
      if (sep === -1) {
        // No separator — treat the whole line as both label and text.
        return { label: line, text: line };
      }
      const label = line.slice(0, sep).trim();
      const body = line.slice(sep + 1).trim();
      return { label, text: body };
    })
    .filter((q) => q.label.length > 0 || q.text.length > 0);
}

/** Render a quick-logs array back to the editable textarea form. */
export function quickLogsToText(logs: QuickLog[]): string {
  return logs.map((q) => `${q.label} | ${q.text}`).join("\n");
}

/**
 * Build the final return URL: `return_to` with the JSON payload appended as a
 * single URL-encoded component. The Pebble app's webview-close handler reads it
 * back off the fragment / query.
 */
export function buildReturnUrl(returnTo: string, payload: PebblePayload): string {
  return returnTo + encodeURIComponent(JSON.stringify(payload));
}

/**
 * Allowlist the final navigation target. The payload carries a vault write token
 * + a rotating refresh token, so handing it to an arbitrary URL would be a
 * credentialed open redirect. Only the Pebble app's webview-close scheme is a
 * legitimate consumer; anything else collapses to the default.
 */
export function validateReturnTo(raw: string | null): string {
  if (raw) {
    try {
      if (new URL(raw).protocol === "pebblejs:") return raw;
    } catch {
      // not a parseable URL — fall through to the default
    }
  }
  return DEFAULT_RETURN_TO;
}

/** Scope string for the chosen vault. The watch writes captures, so request write. */
export function scopeFor(vault: string): string {
  return `vault:${vault}:write`;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(id: string): HTMLElementTagNameMap[K] {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id} element`);
  return node as HTMLElementTagNameMap[K];
}

function setStatus(msg: string, kind: "" | "ok" | "error" = ""): void {
  const status = document.getElementById("status");
  if (!status) return;
  status.textContent = msg;
  status.className = `status${kind ? ` ${kind}` : ""}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Entry point. Three legs:
 *   - OAuth callback (`?code=&state=`) → finish exchange, show editor.
 *   - Fresh visit → stash return_to + current, show the connect form.
 */
export async function boot(): Promise<void> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (code && state) {
    await completeCallback(code, state);
    return;
  }

  // Fresh visit — capture return_to + current from the query and stash them so
  // they survive the OAuth redirect round-trip.
  const returnTo = validateReturnTo(url.searchParams.get("return_to"));
  const current = parseCurrent(url.searchParams.get("current"));
  sessionStorage.setItem(SS_RETURN_TO, returnTo);
  sessionStorage.setItem(SS_CURRENT, JSON.stringify(current));

  renderConnect(current);
}

function readStoredCurrent(): CurrentConfig {
  const raw = sessionStorage.getItem(SS_CURRENT);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CurrentConfig;
  } catch {
    return {};
  }
}

async function completeCallback(code: string, state: string): Promise<void> {
  setStatus("Finishing sign-in…");
  let pending: PendingOAuthState;
  let token: TokenResponse;
  try {
    const result = await completeOAuth(code, state);
    pending = result.pending;
    token = result.token;
  } catch (err) {
    if (err instanceof PendingApprovalError) {
      setStatus(
        "Your hub needs to approve this app before sign-in can finish. " +
          "Approve it on your hub, then try again.",
        "error",
      );
      return;
    }
    setStatus(`Sign-in failed: ${(err as Error).message}`, "error");
    return;
  }

  // Strip code/state from the URL so a reload doesn't replay the (now spent)
  // authorization code. Land back on the page's own base path.
  window.history.replaceState({}, "", window.location.pathname.replace(/oauth\/callback\/?$/, ""));

  // Derive the vault back out of the granted scope (vault:<name>:write), falling
  // back to the prefilled current.vault, then "default".
  const current = readStoredCurrent();
  const vault = vaultFromScope(token.scope) ?? current.vault ?? "default";
  renderEditor(pending, token, vault, current);
  setStatus("Connected.", "ok");
}

/** Pull the vault name out of a `vault:<name>:write` scope grant, if present. */
function vaultFromScope(scope: string | undefined): string | null {
  if (!scope) return null;
  for (const s of scope.split(/\s+/)) {
    const m = /^vault:([^:]+):/.exec(s);
    if (m?.[1]) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// View: connect (hub + vault + Sign in)
// ---------------------------------------------------------------------------

function renderConnect(current: CurrentConfig): void {
  const view = el<"div">("view");
  const defaultHub = current.hub ?? "";
  const defaultVault = current.vault ?? "default";
  view.innerHTML = `
    <div class="panel">
      <label for="hub">Hub origin</label>
      <input id="hub" type="text" inputmode="url" value="${escapeAttr(defaultHub)}"
        placeholder="https://your-tunnel.example.com" autocomplete="off"
        autocapitalize="off" autocorrect="off" spellcheck="false" />
      <p class="hint">Your hub's URL as your phone can reach it — usually your
        Cloudflare-tunnel address, not <code>localhost</code>.</p>

      <label for="vault">Vault</label>
      <input id="vault" type="text" value="${escapeAttr(defaultVault)}" autocomplete="off"
        autocapitalize="off" autocorrect="off" spellcheck="false" />
      <p class="hint">The vault on your hub the watch should write captures into.</p>

      <button id="connect">Sign in with your hub</button>
      <p class="hint">First connect may show an approve-once screen on your hub.</p>
    </div>
  `;

  el<"button">("connect").addEventListener("click", () => {
    const hub = normalizeHubUrl(el<"input">("hub").value);
    const vault = el<"input">("vault").value.trim() || "default";
    if (!hub) {
      setStatus("Enter your hub origin first.", "error");
      return;
    }
    void startOAuth(hub, vault);
  });
}

async function startOAuth(hub: string, vault: string): Promise<void> {
  const connectBtn = el<"button">("connect");
  connectBtn.disabled = true;
  setStatus("Connecting to your hub…");
  try {
    const { authorizeUrl } = await beginOAuth(hub, scopeFor(vault));
    window.location.assign(authorizeUrl);
  } catch (err) {
    connectBtn.disabled = false;
    if (err instanceof InsecureContextError) {
      setStatus(err.message, "error");
      return;
    }
    setStatus(`Could not start sign-in: ${(err as Error).message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// View: quick-logs editor
// ---------------------------------------------------------------------------

function renderEditor(
  pending: PendingOAuthState,
  token: TokenResponse,
  vault: string,
  current: CurrentConfig,
): void {
  const view = el<"div">("view");
  const seed = current.quicklogs && current.quicklogs.length > 0 ? current.quicklogs : [];
  view.innerHTML = `
    <div class="panel">
      <p>Signed in to <span class="vault-badge">${escapeHtml(vault)}</span> on
        <span class="vault-badge">${escapeHtml(pending.hubUrl)}</span>.</p>
      <label for="quicklogs">Quick logs</label>
      <p class="hint">One per line, as <code>Label | note text</code>. The watch shows the
        label; tapping it writes the note text to your vault.</p>
      <textarea id="quicklogs" spellcheck="false">${escapeHtml(quickLogsToText(seed))}</textarea>
      <button id="save">Save &amp; return to watch</button>
    </div>
  `;

  el<"button">("save").addEventListener("click", () => {
    save(pending, token, vault);
  });
}

function save(pending: PendingOAuthState, token: TokenResponse, vault: string): void {
  const saveBtn = el<"button">("save");
  saveBtn.disabled = true;
  setStatus("Saving…");

  const quicklogs = parseQuickLogsText(el<"textarea">("quicklogs").value);
  const returnTo = validateReturnTo(sessionStorage.getItem(SS_RETURN_TO));

  const payload: PebblePayload = {
    hub: pending.hubUrl,
    vault,
    token: token.access_token,
    refresh_token: token.refresh_token ?? "",
    token_endpoint: pending.tokenEndpoint,
    client_id: pending.clientId,
    quicklogs,
  };

  setStatus("Returning to your watch…", "ok");
  window.location.assign(buildReturnUrl(returnTo, payload));
}

// Auto-boot in the browser. Guarded so the module can be imported in tests
// (Bun's test runner has no `document`) without firing the DOM path.
if (typeof document !== "undefined" && document.getElementById("view")) {
  void boot().catch((err) => setStatus(`Unexpected error: ${(err as Error).message}`, "error"));
}
