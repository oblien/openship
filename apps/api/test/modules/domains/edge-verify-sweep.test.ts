import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sweep exists for one failure: a box that deploys nothing for three months.
 *
 * Openship Cloud proves target control once and renews by RE-PROBING THE SAME TOKEN
 * within 7 days of the 90-day expiry. Deploys re-assert the token already, so an
 * active install is covered. An idle one is not — its host state dir gets wiped or the
 * server is rebuilt, nothing writes the token back, and the free domain stops
 * resolving ~83 days after a perfectly green deploy with no record of why.
 *
 * The rule that shapes it: re-requesting a challenge RESETS the token upstream, so
 * "refreshing" a verification Cloud is about to re-probe successfully is the one
 * action here that could break a working route. It therefore repairs and reports, and
 * calls Cloud only for a proof that has already expired.
 */

const { listAll, servableTokens, recordServeError, ensureTargetVerified, probeOwnToken, resolveRoutingFor } =
  vi.hoisted(() => ({
    listAll: vi.fn(),
    servableTokens: vi.fn(),
    recordServeError: vi.fn(),
    ensureTargetVerified: vi.fn(),
    probeOwnToken: vi.fn(),
    resolveRoutingFor: vi.fn(),
  }));

vi.mock("@repo/db", () => ({
  repos: { edgeTargetVerification: { listAll, servableTokens, recordServeError } },
}));
vi.mock("../../../src/lib/edge-target-verify", () => ({
  ensureTargetVerified,
  probeOwnToken,
  resolveRoutingFor,
}));

import { runEdgeVerifySweep } from "../../../src/modules/domains/edge-verify-schedule";
import { servableTokens as realServableTokens } from "../../../../../packages/db/src/repos/edge-target-verification.repo";

const DAY = 24 * 60 * 60 * 1000;

function row(over: Record<string, unknown> = {}) {
  return {
    id: "etv_1",
    organizationId: "org-1",
    target: "http://203.0.113.10",
    host: "203.0.113.10",
    serverId: null,
    token: "tok-new",
    retiredTokens: ["tok-old"],
    challengePath: "/.well-known/oblien-proxy-challenge/tok-new",
    status: "verified",
    expiresAt: new Date(Date.now() + 60 * DAY),
    lastError: null,
    ...over,
  };
}

let serveEdgeChallenge: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  serveEdgeChallenge = vi.fn(async () => ({ served: true, via: "challenge-vhost" }));
  resolveRoutingFor.mockResolvedValue({ serveEdgeChallenge });
  servableTokens.mockImplementation(realServableTokens);
  recordServeError.mockResolvedValue(undefined);
  probeOwnToken.mockResolvedValue({ ok: true });
  ensureTargetVerified.mockResolvedValue({ verified: true });
  listAll.mockResolvedValue([row()]);
});

afterEach(() => vi.restoreAllMocks());

describe("runEdgeVerifySweep", () => {
  it("re-asserts every owed token and confirms the target answers", async () => {
    const r = await runEdgeVerifySweep();

    expect(serveEdgeChallenge).toHaveBeenCalledWith({
      host: "203.0.113.10",
      tokens: ["tok-new", "tok-old"],
    });
    expect(probeOwnToken).toHaveBeenCalledWith(
      "http://203.0.113.10",
      "/.well-known/oblien-proxy-challenge/tok-new",
      "tok-new",
    );
    expect(r).toMatchObject({ targets: 1, reasserted: 1, serving: 1, notServing: 0, failed: 0 });
  });

  it("does NOT call Cloud for a target that is still verified", async () => {
    // Re-requesting resets the token. Refreshing a proof whose re-probe is about to
    // succeed is the one way this job could break a working free domain.
    await runEdgeVerifySweep();

    expect(ensureTargetVerified).not.toHaveBeenCalled();
  });

  it("records a durable reason when the token is re-asserted but still not served", async () => {
    // Without this, "we wrote the file" is the strongest thing anyone could say about
    // a route Cloud is about to silently drop.
    probeOwnToken.mockResolvedValue({ ok: false, reason: "HTTP 404 from http://203.0.113.10/..." });

    const r = await runEdgeVerifySweep();

    expect(r).toMatchObject({ reasserted: 1, serving: 0, notServing: 1 });
    expect(recordServeError).toHaveBeenCalledWith("etv_1", expect.stringContaining("HTTP 404"));
    expect(recordServeError).toHaveBeenCalledWith("etv_1", expect.stringContaining("will stop"));
  });

  it("clears a stale error once the target is answering again", async () => {
    listAll.mockResolvedValue([row({ lastError: "was not answering" })]);

    await runEdgeVerifySweep();

    expect(recordServeError).toHaveBeenCalledWith("etv_1", null);
  });

  it("leaves the error untouched when nothing was wrong — no pointless writes", async () => {
    await runEdgeVerifySweep();

    expect(recordServeError).not.toHaveBeenCalled();
  });

  it("counts a verified row inside the 7-day renewal window", async () => {
    // Inside it, a token we are not serving is an active problem, not a future one.
    listAll.mockResolvedValue([row({ expiresAt: new Date(Date.now() + 3 * DAY) })]);

    expect(await runEdgeVerifySweep()).toMatchObject({ renewingSoon: 1, serving: 1 });
  });

  describe("an expired proof is the one case it re-verifies", () => {
    it("re-verifies by status, since the route is already off", async () => {
      listAll.mockResolvedValue([row({ status: "expired", expiresAt: new Date(Date.now() - DAY) })]);

      const r = await runEdgeVerifySweep();

      expect(ensureTargetVerified).toHaveBeenCalledWith(
        "org-1",
        "http://203.0.113.10",
        expect.objectContaining({ routing: expect.anything() }),
      );
      expect(r).toMatchObject({ reverified: 1, reasserted: 0 });
    });

    it("re-verifies on a past expiry even if the status still says verified", async () => {
      // Nothing tells us the upstream expired it — the timestamp is the only signal a
      // box that hasn't deployed in months has.
      listAll.mockResolvedValue([row({ status: "verified", expiresAt: new Date(Date.now() - DAY) })]);

      await runEdgeVerifySweep();

      expect(ensureTargetVerified).toHaveBeenCalled();
    });

    it("counts a re-verification that fails", async () => {
      listAll.mockResolvedValue([row({ status: "expired" })]);
      ensureTargetVerified.mockResolvedValue({ verified: false, reason: "still unreachable" });

      expect(await runEdgeVerifySweep()).toMatchObject({ reverified: 0, failed: 1 });
    });
  });

  describe("resilience", () => {
    it("one unreachable server does not stop the sweep for the others", async () => {
      listAll.mockResolvedValue([
        row({ id: "etv_1", serverId: "srv-dead" }),
        row({ id: "etv_2", serverId: "srv-ok", target: "http://198.51.100.7", host: "198.51.100.7" }),
      ]);
      resolveRoutingFor.mockImplementation(async (_org: string, serverId?: string) => {
        if (serverId === "srv-dead") throw new Error("ssh: connect timed out");
        return { serveEdgeChallenge };
      });

      const r = await runEdgeVerifySweep();

      expect(r).toMatchObject({ targets: 2, failed: 1, serving: 1 });
      expect(serveEdgeChallenge).toHaveBeenCalledTimes(1);
    });

    it("resolves routing once per box, not once per target", async () => {
      // Building a platform runs a paths probe and can self-heal the edge under a
      // provision lock; several targets can share one server.
      listAll.mockResolvedValue([
        row({ id: "etv_1", serverId: "srv-1" }),
        row({ id: "etv_2", serverId: "srv-1", target: "http://198.51.100.7", host: "198.51.100.7" }),
      ]);

      await runEdgeVerifySweep();

      expect(resolveRoutingFor).toHaveBeenCalledTimes(1);
    });

    it("records a reason when the box that serves a target can't be reached at all", async () => {
      resolveRoutingFor.mockResolvedValue(null);

      const r = await runEdgeVerifySweep();

      expect(r).toMatchObject({ failed: 1, reasserted: 0 });
      expect(recordServeError).toHaveBeenCalledWith("etv_1", expect.stringContaining("re-assert"));
      expect(probeOwnToken).not.toHaveBeenCalled();
    });

    it("records a reason when the edge refuses to serve the token", async () => {
      serveEdgeChallenge = vi.fn(async () => ({ served: false, reason: "already served by legacy.conf" }));
      resolveRoutingFor.mockResolvedValue({ serveEdgeChallenge });

      const r = await runEdgeVerifySweep();

      expect(r).toMatchObject({ failed: 1, serving: 0 });
      expect(recordServeError).toHaveBeenCalledWith("etv_1", expect.stringContaining("legacy.conf"));
      expect(probeOwnToken).not.toHaveBeenCalled();
    });

    it("skips a target that never had a token issued", async () => {
      listAll.mockResolvedValue([row({ token: null, retiredTokens: null, status: "pending" })]);

      const r = await runEdgeVerifySweep();

      expect(serveEdgeChallenge).not.toHaveBeenCalled();
      expect(r).toMatchObject({ targets: 1, reasserted: 0, failed: 0 });
    });

    it("does nothing at all when no target has ever been verified", async () => {
      listAll.mockResolvedValue([]);

      expect(await runEdgeVerifySweep()).toMatchObject({ targets: 0 });
      expect(resolveRoutingFor).not.toHaveBeenCalled();
    });
  });
});
