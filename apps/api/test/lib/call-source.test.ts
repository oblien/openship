import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  ambientCallSource,
  internalSourceHeader,
  isAuditSource,
  resolveCallSource,
  runWithCallSource,
} from "../../src/lib/call-source";

/**
 * `audit_event.source` answers "what did the AI assistant do here", so the value
 * has to be trustworthy in exactly one direction: a caller must not be able to
 * make their own writes look like somebody else's surface — and above all must
 * not be able to claim `mcp` or `dashboard`.
 *
 * The problem it solves: an MCP tool call is not its own kind of HTTP request.
 * mcp-dispatch re-enters the app through `app.fetch()` carrying the caller's
 * bearer token, so at the middleware layer an MCP-driven write and a scripted PAT
 * write are byte-identical. The dispatcher therefore states the source — and
 * signs the claim with a nonce generated at boot and never sent anywhere, so only
 * a request originating inside this process can produce a valid one.
 */

/** Resolve the source for one synthetic request. */
async function sourceFor(opts: {
  headers?: Record<string, string>;
  /** Partial RequestContext to install, or omit for a request that never authed. */
  ctx?: Record<string, unknown>;
}): Promise<string> {
  const app = new Hono();
  app.get("/probe", (c: Context) => {
    if (opts.ctx) c.set("ctx" as never, opts.ctx as never);
    return c.json({ source: resolveCallSource(c) });
  });
  const res = await app.request("/probe", { headers: opts.headers });
  return ((await res.json()) as { source: string }).source;
}

const CLI_UA = "openship-cli/0.5.0";
const BROWSER_UA = "Mozilla/5.0 (Macintosh)";

const cookieCtx = { sessionKind: "cookie", principalKind: null };
const zeroAuthCtx = { sessionKind: "zero-auth", principalKind: null };
const oauthCtx = { sessionKind: "bearer", principalKind: "oauth" };
const patCtx = { sessionKind: "bearer", principalKind: "pat" };

describe("a claimed source is trusted only when it came from this process", () => {
  it("trusts the header the MCP dispatcher sends", async () => {
    // The one path that makes the MCP filter possible: the re-dispatched request
    // authenticates as a plain bearer call, and only this header separates them.
    expect(await sourceFor({ headers: internalSourceHeader("mcp"), ctx: patCtx })).toBe("mcp");
  });

  it("ignores a forged claim and derives the source instead", async () => {
    const forged = { "x-openship-call-source": "mcp.deadbeefdeadbeefdeadbeefdeadbeef" };
    expect(await sourceFor({ headers: forged, ctx: patCtx })).toBe("api");
  });

  it("ignores a claim with no nonce at all", async () => {
    expect(await sourceFor({ headers: { "x-openship-call-source": "mcp" }, ctx: patCtx })).toBe("api");
    expect(await sourceFor({ headers: { "x-openship-call-source": ".mcp" }, ctx: patCtx })).toBe("api");
  });

  it("ignores a valid nonce carrying a source that is not one of ours", async () => {
    const nonce = internalSourceHeader("mcp")["x-openship-call-source"]!.split(".").pop()!;
    const bogus = { "x-openship-call-source": `superuser.${nonce}` };
    expect(await sourceFor({ headers: bogus, ctx: patCtx })).toBe("api");
  });

  it("cannot be used to impersonate the dashboard either", async () => {
    const forged = { "x-openship-call-source": "dashboard.not-the-nonce" };
    expect(await sourceFor({ headers: forged, ctx: patCtx })).toBe("api");
  });
});

describe("derivation from the credential", () => {
  it("a cookie session is the dashboard", async () => {
    expect(await sourceFor({ ctx: cookieCtx, headers: { "user-agent": BROWSER_UA } })).toBe("dashboard");
  });

  it("a zero-auth session is the dashboard (single-user local box)", async () => {
    expect(await sourceFor({ ctx: zeroAuthCtx })).toBe("dashboard");
  });

  it("an OAuth bearer is MCP — our OAuth tokens are only issued to MCP clients", async () => {
    // This is the fallback for a direct MCP-token HTTP call, where there is no
    // internal dispatch to stamp the header.
    expect(await sourceFor({ ctx: oauthCtx })).toBe("mcp");
  });

  it("a PAT with the CLI user agent is the CLI", async () => {
    expect(await sourceFor({ ctx: patCtx, headers: { "user-agent": CLI_UA } })).toBe("cli");
  });

  it("any other bearer is a plain API call", async () => {
    expect(await sourceFor({ ctx: patCtx, headers: { "user-agent": "curl/8.4.0" } })).toBe("api");
    expect(await sourceFor({ ctx: patCtx })).toBe("api");
  });

  it("a spoofed CLI user agent can only downgrade api → cli, never reach mcp", async () => {
    // The UA is the one soft signal in here, so what it can reach matters more
    // than whether it can be faked.
    const spoofed = { "user-agent": CLI_UA };
    expect(await sourceFor({ ctx: patCtx, headers: spoofed })).toBe("cli");
    expect(await sourceFor({ ctx: oauthCtx, headers: spoofed })).toBe("mcp");
  });
});

describe("requests with no RequestContext", () => {
  it("falls back to headers rather than throwing", async () => {
    // Better Auth's /api/auth/* handlers bypass our auth middleware, and those
    // rows (member added, invitation accepted) are the ones a security reviewer
    // reads first — sourceless is the outcome to avoid.
    expect(await sourceFor({})).toBe("dashboard");
    expect(await sourceFor({ headers: { authorization: "Bearer t", "user-agent": CLI_UA } })).toBe("cli");
    expect(await sourceFor({ headers: { authorization: "Bearer t" } })).toBe("api");
  });

  it("credits the CLI for an UNAUTHENTICATED call it made", async () => {
    // `admin.bootstrapped` (setup.controller) is the case: the route runs before
    // any credential exists, so keying on `authorization` alone filed every
    // `openship up` install under "dashboard". The UA is all there is to go on.
    expect(await sourceFor({ headers: { "user-agent": CLI_UA } })).toBe("cli");
    expect(await sourceFor({ headers: { "user-agent": BROWSER_UA } })).toBe("dashboard");
  });

  it("still honours a trusted claim", async () => {
    expect(await sourceFor({ headers: internalSourceHeader("webhook") })).toBe("webhook");
  });
});

describe("ambient source for emitters outside the handler chain", () => {
  it("is null outside a request", () => {
    expect(ambientCallSource()).toBeNull();
  });

  it("seeds from headers and is upgraded in place once a handler resolves", async () => {
    const seen: (string | null)[] = [];
    const app = new Hono();
    app.use("*", (c, next) => runWithCallSource(c, next));
    app.get("/probe", (c: Context) => {
      seen.push(ambientCallSource()); // header-derived seed
      c.set("ctx" as never, oauthCtx as never);
      resolveCallSource(c);
      seen.push(ambientCallSource()); // upgraded by the resolve above
      return c.json({});
    });
    await app.request("/probe", { headers: { authorization: "Bearer t" } });
    expect(seen).toEqual(["api", "mcp"]);
  });

  it("does not leak between requests", async () => {
    const app = new Hono();
    app.use("*", (c, next) => runWithCallSource(c, next));
    app.get("/probe", (c: Context) => c.json({ source: ambientCallSource() }));
    const first = await app.request("/probe", { headers: internalSourceHeader("mcp") });
    const second = await app.request("/probe");
    expect((await first.json()).source).toBe("mcp");
    expect((await second.json()).source).toBe("dashboard");
    expect(ambientCallSource()).toBeNull();
  });
});

describe("isAuditSource", () => {
  it("accepts the stored values and nothing else", () => {
    for (const s of ["dashboard", "mcp", "cli", "api", "webhook", "system"]) {
      expect(isAuditSource(s), s).toBe(true);
    }
    expect(isAuditSource("MCP")).toBe(false);
    expect(isAuditSource("")).toBe(false);
    expect(isAuditSource(null)).toBe(false);
    expect(isAuditSource(undefined)).toBe(false);
  });
});
