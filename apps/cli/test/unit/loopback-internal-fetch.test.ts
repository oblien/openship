import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The one internal-token-gated request path (lib/loopback-api internalFetch).
 *
 * Resolution decides WHICH token to try (unit/internal-token.test.ts); this decides what
 * happens around the request — and the three outcomes it keeps apart are the ones the
 * "Unauthorized" bug collapsed into one:
 *
 *   · nothing to authenticate with        → no request is made at all, and the operator
 *                                           is told which store failed and why;
 *   · a candidate the running API refuses → the NEXT candidate is tried (a box that ran
 *                                           bare before compose holds both);
 *   · every candidate refused             → the 401 comes back, reported as "the API is
 *                                           running with a different token", not as a
 *                                           permissions or credentials error.
 */

const h = vi.hoisted(() => ({
  tokens: [] as string[],
  problem: "no internal token on this machine",
  rejected: "the API rejected this machine's internal token",
}));

vi.mock("../../src/lib/internal-token", () => ({
  internalTokenSources: () => ({ tokens: h.tokens, problems: [] }),
  internalTokenProblem: () => h.problem,
  internalTokenRejectedProblem: () => h.rejected,
  resolveInternalToken: () => h.tokens[0] ?? null,
  mintBareInternalToken: () => {
    throw new Error("a reader must never mint");
  },
}));

import { internalFetch, internalGet, internalPost } from "../../src/lib/loopback-api";
import { stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub | undefined;

beforeEach(() => {
  h.tokens = ["only-token"];
});
afterEach(() => {
  fetchStub?.restore();
  fetchStub = undefined;
});

const sentTokens = () => fetchStub!.calls.map((c) => c.headers["x-internal-token"]);

describe("internalFetch", () => {
  it("sends the resolved token and returns the response", async () => {
    fetchStub = stubFetch(() => ({ status: 200, json: { ok: true } }));

    const call = await internalFetch("4000", "/api/system/health");
    expect(call.kind).toBe("response");
    expect(sentTokens()).toEqual(["only-token"]);
    expect(fetchStub.calls[0]!.url).toBe("http://127.0.0.1:4000/api/system/health");
  });

  it("retries the next candidate when the API refuses the first", async () => {
    h.tokens = ["stale-bare", "live-compose"];
    fetchStub = stubFetch((req) =>
      req.headers["x-internal-token"] === "live-compose"
        ? { status: 200, json: { ok: true, email: "a@b.com" } }
        : { status: 401, json: { error: "Unauthorized" } },
    );

    const res = await internalPost("4000", "/api/system/reset-admin-password", { password: "x" });
    expect(res.ok).toBe(true);
    expect(res.data.email).toBe("a@b.com");
    expect(sentTokens()).toEqual(["stale-bare", "live-compose"]);
  });

  it("stops after every candidate is refused and explains the 401", async () => {
    h.tokens = ["one", "two"];
    fetchStub = stubFetch(() => ({ status: 401, json: { error: "Unauthorized" } }));

    const res = await internalPost("4000", "/api/system/reset-admin-password", { password: "x" });
    expect(res.ok).toBe(false);
    // Not the API's bare "Unauthorized" — the operator needs to know the process is
    // running with a different token than the one on disk.
    expect(res.data.error).toBe(h.rejected);
    expect(sentTokens()).toEqual(["one", "two"]);
  });

  it("passes a HANDLER's 401 straight through — no retry, no rewording", async () => {
    // /cloud-connect answers 401 AFTER exchanging a single-use PKCE code. Retrying it
    // with the next token would burn the code, and "the API rejected your token" would
    // blame the wrong thing entirely. Only internalAuth's own `{"error":"Unauthorized"}`
    // is a token rejection.
    h.tokens = ["first", "second"];
    fetchStub = stubFetch(() => ({ status: 401, json: { error: "Could not verify with Openship Cloud" } }));

    const res = await internalPost("4000", "/api/system/cloud-connect", { code: "abc" });
    expect(res.ok).toBe(false);
    expect(res.data.error).toBe("Could not verify with Openship Cloud");
    expect(sentTokens()).toEqual(["first"]);
  });

  it("hands back a streaming response without reading it", async () => {
    // The self-register SSE reader consumes res.body itself; buffering it here to
    // classify the status would stall the wizard until provisioning ended.
    fetchStub = stubFetch(
      () => new Response("event: log\ndata: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );

    const call = await internalFetch("4000", "/api/system/self-register/stream?id=1");
    expect(call.kind).toBe("response");
    if (call.kind !== "response") return;
    expect(call.res.bodyUsed).toBe(false);
    expect(call.res.body).not.toBeNull();
  });

  it("keeps a caller-supplied token exactly as given (no retry, no resolution)", async () => {
    // `openship up`'s compose provisioning holds the token it just wrote; second-guessing
    // it would authenticate against the wrong api on a box with two installs.
    h.tokens = ["resolved"];
    fetchStub = stubFetch(() => ({ status: 401, json: { error: "Unauthorized" } }));

    const res = await internalPost("4000", "/api/system/self-register", {}, "explicit");
    expect(res.ok).toBe(false);
    expect(sentTokens()).toEqual(["explicit"]);
    // The rejection hint is about tokens WE resolved, so an explicit one passes through.
    expect(res.data.error).toBe("Unauthorized");
  });

  it("makes NO request when there is no token, and says which store failed", async () => {
    h.tokens = [];
    h.problem = `can't read /root/.openship/compose/.env (EACCES) — re-run with sudo`;
    fetchStub = stubFetch(() => ({ status: 200, json: { ok: true } }));

    const call = await internalFetch("4000", "/api/system/health");
    expect(call).toEqual({ kind: "no-token", detail: h.problem });
    // Inventing a token to send would be a 401 that hides a permissions problem.
    expect(fetchStub.calls).toHaveLength(0);

    const res = await internalPost("4000", "/api/system/reset-admin-password", { password: "x" });
    expect(res).toEqual({ ok: false, data: { error: h.problem } });
  });

  it("separates an unreachable API from a refused one", async () => {
    fetchStub = stubFetch(() => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
    });

    const call = await internalFetch("4000", "/api/system/health");
    expect(call.kind).toBe("unreachable");
    expect(await internalGet("4000", "/api/system/health")).toBeNull();
  });

  it("returns null from internalGet on a non-ok response", async () => {
    fetchStub = stubFetch(() => ({ status: 500, json: { error: "boom" } }));
    expect(await internalGet("4000", "/api/system/health")).toBeNull();
  });
});
