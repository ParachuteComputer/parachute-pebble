import { describe, expect, test } from "bun:test";

import { basePath, normalizeHubUrl, redirectUri } from "./oauth.ts";
import {
  type PebblePayload,
  type QuickLog,
  buildReturnUrl,
  escapeAttr,
  escapeHtml,
  parseCurrent,
  parseQuickLogsText,
  quickLogsToText,
  scopeFor,
  validateReturnTo,
} from "./main.ts";

describe("parseCurrent", () => {
  test("returns empty config on null / empty / garbage", () => {
    expect(parseCurrent(null)).toEqual({});
    expect(parseCurrent("")).toEqual({});
    expect(parseCurrent("not-json")).toEqual({});
    expect(parseCurrent("[1,2,3]")).toEqual({});
  });

  test("extracts hub, vault, and quicklogs", () => {
    const raw = JSON.stringify({
      hub: "https://hub.example",
      vault: "work",
      quicklogs: [{ label: "Coffee", text: "had a coffee" }],
    });
    expect(parseCurrent(raw)).toEqual({
      hub: "https://hub.example",
      vault: "work",
      quicklogs: [{ label: "Coffee", text: "had a coffee" }],
    });
  });

  test("coerces malformed quicklog entries to empty strings + drops non-objects", () => {
    const raw = JSON.stringify({
      quicklogs: [{ label: 1, text: null }, "nope", { label: "ok" }],
    });
    expect(parseCurrent(raw)).toEqual({
      quicklogs: [
        { label: "", text: "" },
        { label: "ok", text: "" },
      ],
    });
  });

  test("ignores wrong-typed top-level fields", () => {
    const raw = JSON.stringify({ hub: 5, vault: true, quicklogs: "x" });
    expect(parseCurrent(raw)).toEqual({});
  });
});

describe("parseQuickLogsText", () => {
  test("splits `Label | text` per line, trimming whitespace", () => {
    const text = "Coffee | had a coffee\n  Walk |  went for a walk  \n";
    expect(parseQuickLogsText(text)).toEqual([
      { label: "Coffee", text: "had a coffee" },
      { label: "Walk", text: "went for a walk" },
    ]);
  });

  test("a line with no separator becomes label === text", () => {
    expect(parseQuickLogsText("Standup")).toEqual([{ label: "Standup", text: "Standup" }]);
  });

  test("blank lines are dropped", () => {
    expect(parseQuickLogsText("\n\n  \nA | b\n")).toEqual([{ label: "A", text: "b" }]);
  });

  test("text may contain its own pipe — only the first separates", () => {
    expect(parseQuickLogsText("Note | a | b | c")).toEqual([{ label: "Note", text: "a | b | c" }]);
  });
});

describe("quickLogsToText round-trip", () => {
  test("text -> logs -> text is stable for canonical form", () => {
    const canonical = "Coffee | had a coffee\nWalk | went for a walk";
    expect(quickLogsToText(parseQuickLogsText(canonical))).toBe(canonical);
  });

  test("logs -> text -> logs preserves entries", () => {
    const logs: QuickLog[] = [
      { label: "Coffee", text: "had a coffee" },
      { label: "Walk", text: "went for a walk" },
    ];
    expect(parseQuickLogsText(quickLogsToText(logs))).toEqual(logs);
  });
});

describe("buildReturnUrl", () => {
  const payload: PebblePayload = {
    hub: "https://hub.example",
    vault: "default",
    token: "tok",
    refresh_token: "ref",
    token_endpoint: "https://hub.example/oauth/token",
    client_id: "cid",
    quicklogs: [{ label: "A", text: "b" }],
  };

  test("appends URL-encoded JSON to return_to and decodes back to the payload", () => {
    const url = buildReturnUrl("pebblejs://close#", payload);
    expect(url.startsWith("pebblejs://close#")).toBe(true);
    const encoded = url.slice("pebblejs://close#".length);
    expect(JSON.parse(decodeURIComponent(encoded))).toEqual(payload);
  });
});

describe("validateReturnTo", () => {
  test("allows the pebblejs scheme through", () => {
    expect(validateReturnTo("pebblejs://close#")).toBe("pebblejs://close#");
  });

  test("collapses https / garbage / null to the default — the payload carries credentials", () => {
    expect(validateReturnTo("https://evil.example/steal?p=")).toBe("pebblejs://close#");
    expect(validateReturnTo("close#")).toBe("pebblejs://close#");
    expect(validateReturnTo(null)).toBe("pebblejs://close#");
  });
});

describe("scopeFor", () => {
  test("requests write on the named vault", () => {
    expect(scopeFor("default")).toBe("vault:default:write");
    expect(scopeFor("work")).toBe("vault:work:write");
  });
});

describe("escaping", () => {
  test("escapeHtml neutralizes angle brackets + ampersands", () => {
    expect(escapeHtml(`<b>&"</b>`)).toBe(`&lt;b&gt;&amp;"&lt;/b&gt;`);
  });

  test("escapeAttr additionally escapes double quotes", () => {
    expect(escapeAttr(`a"b<c`)).toBe("a&quot;b&lt;c");
  });
});

describe("normalizeHubUrl", () => {
  test("trims and strips trailing slashes", () => {
    expect(normalizeHubUrl("  https://hub.example.com/  ")).toBe("https://hub.example.com");
    expect(normalizeHubUrl("https://hub.example.com///")).toBe("https://hub.example.com");
  });

  test("defaults a bare host to https", () => {
    expect(normalizeHubUrl("hub.example.com")).toBe("https://hub.example.com");
  });

  test("leaves an explicit http:// scheme alone (loopback dev)", () => {
    expect(normalizeHubUrl("http://localhost:1939")).toBe("http://localhost:1939");
  });

  test("empty stays empty (the form guards on this)", () => {
    expect(normalizeHubUrl("   ")).toBe("");
  });
});

// The load-bearing project-Pages behavior: the redirect URI must be built from
// the page's OWN origin + the base path it's served under (/parachute-pebble/),
// and the SAME callback URL must be reconstructable whether we're on the SPA
// root or the ?code= callback leg. DCR binds client_id to redirect_uri by exact
// match, so any drift here breaks the authorize.
describe("basePath / redirectUri (project-Pages base awareness)", () => {
  test("derives the project base path from the SPA root", () => {
    expect(basePath("/parachute-pebble/")).toBe("/parachute-pebble/");
  });

  test("derives the same base on the callback leg", () => {
    expect(basePath("/parachute-pebble/oauth/callback")).toBe("/parachute-pebble/");
  });

  test("handles index.html and the repo root (local preview)", () => {
    expect(basePath("/parachute-pebble/index.html")).toBe("/parachute-pebble/");
    expect(basePath("/")).toBe("/");
  });

  test("redirectUri = origin + base + oauth/callback, stable across legs", () => {
    const root = redirectUri("https://parachutecomputer.github.io", "/parachute-pebble/");
    const cb = redirectUri("https://parachutecomputer.github.io", "/parachute-pebble/oauth/callback");
    expect(root).toBe("https://parachutecomputer.github.io/parachute-pebble/oauth/callback");
    expect(cb).toBe(root);
  });

  test("never spells the callback path with a dash", () => {
    expect(redirectUri("https://parachutecomputer.github.io", "/parachute-pebble/")).not.toContain(
      "oauth-callback",
    );
  });
});
