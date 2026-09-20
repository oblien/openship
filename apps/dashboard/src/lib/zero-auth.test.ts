import { describe, expect, it } from "vitest";

import { resolveZeroAuthLogin } from "./zero-auth";

const NOW = 1_700_000_000_000;

function decide(over: Partial<Parameters<typeof resolveZeroAuthLogin>[0]> = {}) {
  return resolveZeroAuthLogin({
    pageOrigin: "http://localhost:3001",
    apiBaseUrl: "http://localhost:4000/api/",
    attemptedAt: undefined,
    now: NOW,
    ...over,
  });
}

describe("resolveZeroAuthLogin", () => {
  it("bounces a same-machine browser to desktop-login", () => {
    expect(decide()).toEqual({
      action: "redirect",
      url: "http://localhost:4000/api/auth/desktop-login",
    });
  });

  it("builds the URL from the proxied base, not a guessed API origin", () => {
    // Single-port self-hosted (NEXT_PUBLIC_API_PROXY): the API is only reachable
    // beneath the dashboard's own origin.
    expect(decide({ apiBaseUrl: "http://localhost:3001/api/proxy/api/" })).toEqual({
      action: "redirect",
      url: "http://localhost:3001/api/proxy/api/auth/desktop-login",
    });
  });

  it("treats 127.0.0.1 and [::1] as the same machine", () => {
    expect(decide({ pageOrigin: "http://127.0.0.1:3001" }).action).toBe("redirect");
    expect(decide({ pageOrigin: "http://[::1]:3001" }).action).toBe("redirect");
  });

  /**
   * The reported dead end: the dashboard is open on another computer, so the
   * server will never mint a zero-auth session for it. Redirecting sends that
   * browser to ITS OWN loopback address, which is either nothing or somebody
   * else's app.
   */
  it("explains instead of redirecting when the browser is on another machine", () => {
    expect(decide({ pageOrigin: "http://203.0.113.5:3001" })).toEqual({
      action: "explain",
      reason: "remote_browser",
    });
    expect(decide({ pageOrigin: "https://openship.example.com" })).toEqual({
      action: "explain",
      reason: "remote_browser",
    });
  });

  it("explains rather than looping when desktop-login just bounced us back", () => {
    expect(decide({ attemptedAt: NOW - 400 })).toEqual({ action: "explain", reason: "refused" });
  });

  it("retries when the last attempt is old enough to be an expired session", () => {
    expect(decide({ attemptedAt: NOW - 60_000 }).action).toBe("redirect");
  });

  it("ignores a mark from the future rather than locking the page", () => {
    expect(decide({ attemptedAt: NOW + 60_000 }).action).toBe("redirect");
  });

  it("waits during SSR, where there is no origin to judge", () => {
    expect(decide({ pageOrigin: undefined })).toEqual({ action: "wait" });
  });
});
