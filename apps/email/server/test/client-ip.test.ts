import { describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { clientIp } from "../src/lib/client-ip";

type ConnectionEnv = {
  server: {
    requestIP: (
      request: Request,
    ) => { address?: string; family?: string; port?: number } | undefined;
  };
};

// `Record<string, string>` rather than `HeadersInit`: the package compiles with
// `lib: ["ES2022"]` and no DOM lib, so the global DOM alias isn't in scope here.
//
// Resolve the promise here rather than asserting through `.resolves`: Bun types
// that matcher as returning void, so `await expect(...).resolves` awaits a
// non-thenable and the assertion would still pass if it never ran.
async function requestClientIp(headers?: Record<string, string>, env?: ConnectionEnv) {
  const app = new Hono();
  app.get("/", (c) => c.text(clientIp(c)));

  const response = await app.request("http://localhost/", { headers }, env);
  return response.text();
}

describe("clientIp", () => {
  it("uses trimmed x-real-ip and ignores a conflicting x-forwarded-for", async () => {
    const ip = await requestClientIp({
      "x-real-ip": " 203.0.113.7 ",
      "x-forwarded-for": "198.51.100.9",
    });

    expect(ip).toBe("203.0.113.7");
  });

  it("ignores x-forwarded-for when x-real-ip is absent", async () => {
    // The proxy sets x-real-ip and strips inbound copies, so x-forwarded-for is
    // attacker-controlled. Honouring it as a fallback would let a client pick
    // its own rate-limit bucket and walk past the sign-in brute-force guard.
    const ip = await requestClientIp(
      { "x-forwarded-for": "198.51.100.9" },
      { server: { requestIP: () => ({ address: "192.0.2.44" }) } },
    );

    expect(ip).toBe("192.0.2.44");
  });

  it("falls back to unknown when getConnInfo throws outside Bun request context", async () => {
    // Unknown clients share a rate-limit bucket rather than bypassing the limiter.
    expect(await requestClientIp()).toBe("unknown");
  });

  it("returns unknown when getConnInfo has no remote address", async () => {
    const ip = await requestClientIp(undefined, { server: { requestIP: () => ({}) } });

    expect(ip).toBe("unknown");
  });

  it("falls back for empty and all-whitespace x-real-ip values", async () => {
    // `?.trim()` leaves an empty string, which is falsy, so these must reach the
    // connection-info fallback instead of becoming a blank bucket key that every
    // header-stripped request would share.
    for (const xRealIp of ["", "   ", "\t\n"]) {
      const ip = await requestClientIp({
        "x-real-ip": xRealIp,
        "x-forwarded-for": "198.51.100.9",
      });

      expect(ip).toBe("unknown");
    }
  });
});
