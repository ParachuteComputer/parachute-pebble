/**
 * OAuth 2.1 + PKCE + Dynamic Client Registration for the Pebble setup SPA.
 *
 * This is the "external-surface" pattern: a static page served from a FOREIGN
 * origin (github.io) that runs the OAuth dance against WHATEVER hub the user
 * enters. It is adapted — with thanks — from Parachute's My Vault UI
 * (`src/vault/oauth.ts` + `src/vault/pkce.ts`) and the surface-client the
 * in-repo `pebble-config` surface used. Collapsed into one self-contained
 * module so the page ships with zero npm runtime dependencies.
 *
 * Two deliberate differences from My Vault UI:
 *
 *   1. The user enters a HUB ORIGIN (not a vault URL). Discovery,
 *      registration, authorize, and token exchange all target the hub:
 *      GET <hub>/.well-known/oauth-authorization-server. (On a stock Parachute
 *      server — hub + vault only — the hub IS the authorization server.)
 *   2. The redirect URI is built from this page's OWN origin + base path
 *      (e.g. https://parachutecomputer.github.io/parachute-pebble/oauth/callback),
 *      so the callback lands back on this same static page. Because the page is
 *      on github.io and the hub is on a different origin, every cross-origin
 *      call (DCR, token) sends `credentials: "include"` — the hub's CORS on
 *      `/oauth/*` echoes the origin and allows credentials, so a signed-in hub
 *      owner auto-approves; otherwise the hub shows an approve-once page.
 */

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) — pure Web Crypto, no dependencies. Verbatim shape from the
// Parachute surface-client / My Vault UI implementations.
//
// crypto.subtle requires a secure context; github.io is HTTPS so this is fine.
// We still guard so a misconfigured deploy fails loudly, not cryptically.
// ---------------------------------------------------------------------------

export class InsecureContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsecureContextError";
  }
}

const INSECURE_CONTEXT_MESSAGE =
  "OAuth requires a secure context (HTTPS). Web Crypto isn't available here. " +
  "Open this page over HTTPS.";

function assertWebCryptoDigest(): void {
  if (typeof crypto === "undefined" || !crypto.subtle?.digest) {
    throw new InsecureContextError(INSECURE_CONTEXT_MESSAGE);
  }
}

function assertWebCryptoRandom(): void {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new InsecureContextError(INSECURE_CONTEXT_MESSAGE);
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(bytes = 32): string {
  if (bytes < 32 || bytes > 96) {
    throw new Error("code_verifier entropy must be between 32 and 96 bytes");
  }
  assertWebCryptoRandom();
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

export async function deriveCodeChallenge(verifier: string): Promise<string> {
  assertWebCryptoDigest();
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

export function generateState(bytes = 16): string {
  assertWebCryptoRandom();
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  code_challenge_methods_supported?: string[];
}

export interface ClientRegistration {
  client_id: string;
  redirect_uris?: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface PendingOAuthState {
  hubUrl: string;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
  scope: string;
  startedAt: string;
}

/** Raised when the token endpoint says the app still needs approval in the hub. */
export class PendingApprovalError extends Error {
  approveUrl: string | undefined;
  constructor(approveUrl: string | undefined) {
    super("Your hub needs to approve this app before sign-in can finish.");
    this.name = "PendingApprovalError";
    this.approveUrl = approveUrl;
  }
}

export const CLIENT_NAME = "Parachute Pebble Setup";

// ---------------------------------------------------------------------------
// Redirect URI — this page's own origin + base path + oauth/callback.
//
// On project Pages the page is served under /parachute-pebble/, so the base is
// the directory the page lives in. We derive it from location.pathname rather
// than hardcoding so the same bundle works at the repo root in local preview.
// The hub binds client_id to redirect_uri (exact match), so this must be stable
// between the authorize leg and what DCR registered.
// ---------------------------------------------------------------------------

const REDIRECT_PATH = "oauth/callback";

/** Base path the page is served from, with a trailing slash (e.g. "/parachute-pebble/"). */
export function basePath(pathname: string = window.location.pathname): string {
  // Strip a trailing "oauth/callback" (the callback leg) and any index.html,
  // then ensure a single trailing slash. What remains is the directory the SPA
  // is mounted at.
  let p = pathname.replace(/\/oauth\/callback\/?$/, "/").replace(/index\.html$/, "");
  if (!p.endsWith("/")) p = p.replace(/[^/]*$/, "");
  if (!p.endsWith("/")) p += "/";
  return p;
}

export function redirectUri(
  origin: string = window.location.origin,
  pathname: string = window.location.pathname,
): string {
  return `${origin.replace(/\/$/, "")}${basePath(pathname)}${REDIRECT_PATH}`;
}

// ---------------------------------------------------------------------------
// Normalization — accept "example.com", "https://example.com/", etc.
// ---------------------------------------------------------------------------

export function normalizeHubUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, "");
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
}

function normalizeIssuerKey(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Storage: pending PKCE (sessionStorage) + DCR client_id cache (localStorage)
// ---------------------------------------------------------------------------

const PENDING_OAUTH_KEY = "pebble.oauth.pending";
const DCR_PREFIX = "pebble.dcr:";

function read<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function write(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — best-effort only */
  }
}

export function loadPendingOAuth(): PendingOAuthState | null {
  return read<PendingOAuthState>(sessionStorage, PENDING_OAUTH_KEY);
}

function savePendingOAuth(state: PendingOAuthState): void {
  write(sessionStorage, PENDING_OAUTH_KEY, state);
}

export function clearPendingOAuth(): void {
  try {
    sessionStorage.removeItem(PENDING_OAUTH_KEY);
  } catch {
    /* best-effort */
  }
}

interface CachedClientRegistration {
  clientId: string;
  redirectUri: string;
  registeredAt: string;
}

// DCR client_id cached per (issuer, redirectUri) so we register at most once per
// browser per issuer. Re-register when the redirect URI changes — the hub binds
// client_id to redirect_uri and would reject the authorize otherwise.
function loadCachedClientId(issuer: string, redirect: string): string | null {
  const cached = read<CachedClientRegistration>(localStorage, DCR_PREFIX + normalizeIssuerKey(issuer));
  if (!cached) return null;
  if (cached.redirectUri !== redirect) return null;
  return cached.clientId;
}

function saveCachedClientId(issuer: string, redirect: string, clientId: string): void {
  write(localStorage, DCR_PREFIX + normalizeIssuerKey(issuer), {
    clientId,
    redirectUri: redirect,
    registeredAt: new Date().toISOString(),
  } satisfies CachedClientRegistration);
}

// ---------------------------------------------------------------------------
// Discovery (RFC 8414)
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS: (keyof AuthorizationServerMetadata)[] = [
  "issuer",
  "authorization_endpoint",
  "token_endpoint",
  "registration_endpoint",
];

export async function discoverAuthServer(
  hubUrl: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<AuthorizationServerMetadata> {
  const metadataUrl = `${hubUrl.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
  let res: Response;
  try {
    res = await fetchImpl(metadataUrl, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new Error(`Could not reach the hub at ${hubUrl}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`Discovery failed (${res.status}). Is this a Parachute hub URL? Tried ${metadataUrl}`);
  }
  const data = (await res.json()) as AuthorizationServerMetadata;
  for (const field of REQUIRED_FIELDS) {
    if (typeof data[field] !== "string" || !data[field]) {
      throw new Error(`Discovery response missing ${field}`);
    }
  }
  if (!data.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("Hub does not advertise S256 PKCE — cannot complete OAuth safely");
  }
  return data;
}

// ---------------------------------------------------------------------------
// DCR (RFC 7591)
// ---------------------------------------------------------------------------

export async function registerClient(
  registrationEndpoint: string,
  redirect: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<ClientRegistration> {
  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    // Sends the hub session cookie so a signed-in hub owner auto-approves
    // (hub same-hub auto-trust). The hub's CORS on this endpoint reflects the
    // github.io origin + Access-Control-Allow-Credentials: true.
    credentials: "include",
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Client registration failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as ClientRegistration;
  if (!data.client_id) {
    throw new Error("Registration response missing client_id");
  }
  return data;
}

// ---------------------------------------------------------------------------
// begin / complete / refresh
// ---------------------------------------------------------------------------

/**
 * Begin the OAuth flow against a hub URL: discover the AS, reuse or register a
 * client_id (DCR), stash PKCE state, return the authorize URL to redirect to.
 */
export async function beginOAuth(
  hubInput: string,
  scope: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<{ authorizeUrl: string; pending: PendingOAuthState }> {
  const hubUrl = normalizeHubUrl(hubInput);
  const redirect = redirectUri();

  const metadata = await discoverAuthServer(hubUrl, fetchImpl);

  let clientId = loadCachedClientId(metadata.issuer, redirect);
  if (!clientId) {
    const registration = await registerClient(metadata.registration_endpoint, redirect, fetchImpl);
    clientId = registration.client_id;
    saveCachedClientId(metadata.issuer, redirect, clientId);
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await deriveCodeChallenge(codeVerifier);
  const state = generateState();

  const pending: PendingOAuthState = {
    hubUrl,
    issuer: metadata.issuer,
    tokenEndpoint: metadata.token_endpoint,
    clientId,
    codeVerifier,
    state,
    redirectUri: redirect,
    scope,
    startedAt: new Date().toISOString(),
  };
  savePendingOAuth(pending);

  const authorizeUrl = new URL(metadata.authorization_endpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirect);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", scope);

  return { authorizeUrl: authorizeUrl.toString(), pending };
}

function safeApproveUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  return raw;
}

function parsePendingApproval(text: string): { approveUrl: string | undefined } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  if (body.error !== "invalid_client") return null;
  return { approveUrl: safeApproveUrl(body.approve_url) };
}

/**
 * Complete the flow: verify state, POST the code + PKCE verifier to the token
 * endpoint, clear pending state. Returns the pending context (so the caller
 * knows which hub the token is for) and the token response.
 */
export async function completeOAuth(
  code: string,
  state: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<{ pending: PendingOAuthState; token: TokenResponse }> {
  const pending = loadPendingOAuth();
  if (!pending) {
    throw new Error("No pending sign-in. Start again from the setup screen.");
  }
  if (pending.state !== state) {
    clearPendingOAuth();
    throw new Error("Sign-in state mismatch. The flow was interrupted — please try again.");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: pending.codeVerifier,
    client_id: pending.clientId,
    redirect_uri: pending.redirectUri,
  });

  const res = await fetchImpl(pending.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    credentials: "include",
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    clearPendingOAuth();
    const pendingApproval = parsePendingApproval(text);
    if (pendingApproval) {
      throw new PendingApprovalError(pendingApproval.approveUrl);
    }
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const token = (await res.json()) as TokenResponse;
  if (!token.access_token) {
    clearPendingOAuth();
    throw new Error("Token response missing access_token");
  }

  clearPendingOAuth();
  return { pending, token };
}
