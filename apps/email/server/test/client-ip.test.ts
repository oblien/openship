import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// `client-ip.ts` imports `hono/bun`, whose barrel also pulls in the SSG and
// websocket adapters — those dereference the `Bun` global at module load, so
// importing it under vitest's Node runtime throws `Bun is not defined` before
// a single test runs. Only `getConnInfo` is actually used here, and its own
// module is runtime-agnostic: it reads `env.server.requestIP(c.req.raw)`.
// Re-implementing that one function keeps the real `clientIp` under test
// (header precedence, trimming, and the throwing-fallback path are all its
// own logic) while sidestepping the unrelated adapter side effects.
vi.mock("hono/bun", () => ({
  getConnInfo: (c: { env?: ConnectionEnv; req: { raw: Request } }) => {
    const server = c.env?.server;
    if (!server) throw new Error("env.server is not defined");
    return { remote: server.requestIP(c.req.raw) ?? {} };
  },
}));

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
// Resolve the promise before asserting rather than going through `.resolves`:
// that keeps the assertion on a plain value, so a matcher that silently no-ops
// can't let a case pass without ever running.
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
