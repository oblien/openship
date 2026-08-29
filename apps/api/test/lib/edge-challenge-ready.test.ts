import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveEdgeTargetHost, findByTarget } = vi.hoisted(() => ({
  resolveEdgeTargetHost: vi.fn(),
  findByTarget: vi.fn(),
}));

vi.mock("@repo/db", async () => {
  const { servableTokens } = await vi.importActual<
    typeof import("../../../../packages/db/src/repos/edge-target-verification.repo")
  >("../../../../packages/db/src/repos/edge-target-verification.repo");
  return {
    repos: {
      edgeTargetVerification: {
        findByTarget,
        servableTokens,
      },
    },
  };
});
vi.mock("../../src/lib/edge-target", () => ({
  resolveEdgeTargetHost,
  canonicalEdgeTarget: (h: string) => `http://${h}`,
}));

import { ensureEdgeChallengeReady } from "../../src/lib/edge-challenge";

/**
 * Preparing the box to answer Openship Cloud's target check runs at EDGE-ENSURE, not
 * when a free domain is added, because the challenge location serves a directory and
 * so the vhost is valid before any token exists.
 *
 * That timing is the whole point: the container edge is the only install path and it
 * takes its `:80` catch-all from the BAKED image, so a box on an older pinned image —
 * or one rolled back to it — has no catch-all to answer with. The vhost this writes
 * lands in the bind-mounted sites-enabled from our own code, so it works on every
 * image version.
 */
const routingWith = (served: boolean, extra: Record<string, unknown> = {}) => {
  const serveEdgeChallenge = vi.fn(async () => ({ served, via: served ? "challenge-vhost" : null, ...extra }));
  return { routing: { serveEdgeChallenge } as never, serveEdgeChallenge };
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveEdgeTargetHost.mockResolvedValue({ host: "203.0.113.10" });
  findByTarget.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("ensureEdgeChallengeReady", () => {
  it("prepares the resolved target host, with NO tokens", async () => {
    const { routing, serveEdgeChallenge } = routingWith(true);

    const r = await ensureEdgeChallengeReady("org-1", routing, { serverId: "srv-1" });

    expect(r).toEqual({ ready: true, host: "203.0.113.10" });
    // No tokens: nothing has been issued yet, and that's the point.
    expect(serveEdgeChallenge).toHaveBeenCalledWith({ host: "203.0.113.10" });
  });

  it("resolves the target through the SAME resolver the proxy sync uses", async () => {
    // Preparing a different host than Oblien will dial looks identical until the
    // probe 404s, so this must not re-derive the address independently.
    const { routing } = routingWith(true);

    await ensureEdgeChallengeReady("org-1", routing, { serverId: "srv-9" });

    expect(resolveEdgeTargetHost).toHaveBeenCalledWith("org-1", { serverId: "srv-9" });
  });

  it("reports the resolver's reason when no public target exists", async () => {
    resolveEdgeTargetHost.mockResolvedValue({ host: null, reason: "no public address" });
    const { routing, serveEdgeChallenge } = routingWith(true);

    const r = await ensureEdgeChallengeReady("org-1", routing);

    expect(r).toEqual({ ready: false, reason: "no public address" });
    expect(serveEdgeChallenge).not.toHaveBeenCalled();
  });

  it("treats a provider with no HTTP surface as not-applicable, not a failure", async () => {
    // Cloud routes through Oblien's own edge, so its provider implements no
    // serveEdgeChallenge. An absent method is a clean reason, never a throw.
    const r = await ensureEdgeChallengeReady("org-1", { removeRoute: vi.fn() } as never);

    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/no HTTP surface/);
    expect(resolveEdgeTargetHost).not.toHaveBeenCalled();
  });

  it("surfaces a stale vhost claiming the host without throwing", async () => {
    const { routing } = routingWith(false, { reason: "already served by legacy.conf" });
    const onLog = vi.fn();

    const r = await ensureEdgeChallengeReady("org-1", routing, { onLog });

    expect(r).toMatchObject({ ready: false, host: "203.0.113.10" });
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("legacy.conf"));
  });

  it("never throws when the provider does — routing must not fail a deploy", async () => {
    const routing = {
      serveEdgeChallenge: vi.fn(async () => {
        throw new Error("nginx reload failed");
      }),
    } as never;

    const r = await ensureEdgeChallengeReady("org-1", routing);

    expect(r).toMatchObject({ ready: false, reason: "nginx reload failed" });
  });

  it("handles a null routing provider (nothing resolved yet)", async () => {
    expect((await ensureEdgeChallengeReady("org-1", null)).ready).toBe(false);
  });

  describe("re-asserting owed tokens", () => {
    it("writes back every token this target still owes an answer for", async () => {
      // THE self-heal, and the reason the 90-day re-probe survives real operations: a
      // wiped host state dir, a rebuilt server or a restored backup loses the token
      // files while the DB row still says verified. Retired tokens go too — an older
      // record may still be mid-re-probe.
      findByTarget.mockResolvedValue({ token: "tok-new", retiredTokens: ["tok-old"] });
      const { routing, serveEdgeChallenge } = routingWith(true);

      await ensureEdgeChallengeReady("org-1", routing);

      expect(serveEdgeChallenge).toHaveBeenCalledWith({
        host: "203.0.113.10",
        tokens: ["tok-new", "tok-old"],
      });
    });

    it("looks the tokens up under the CANONICAL target, not the bare host", async () => {
      // The row is keyed on the same string the proxy sync sends; reading by anything
      // else would miss it and silently stop serving a live token.
      findByTarget.mockResolvedValue({ token: "tok-new" });
      const { routing } = routingWith(true);

      await ensureEdgeChallengeReady("org-1", routing);

      expect(findByTarget).toHaveBeenCalledWith("org-1", "http://203.0.113.10");
    });

    it("still prepares the location when the token read fails", async () => {
      // Preparation must never fail a deploy, so an unreadable row degrades to the
      // empty state every box starts in rather than throwing.
      findByTarget.mockRejectedValue(new Error("db down"));
      const { routing, serveEdgeChallenge } = routingWith(true);

      const r = await ensureEdgeChallengeReady("org-1", routing);

      expect(r).toEqual({ ready: true, host: "203.0.113.10" });
      expect(serveEdgeChallenge).toHaveBeenCalledWith({ host: "203.0.113.10" });
    });
  });
});
