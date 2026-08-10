import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The state machine that proves to Openship Cloud that this box controls a routing
 * target. Two rules outrank everything else here and are what these tests pin:
 *
 * 1. It is REACTIVE. It only runs after a sync came back `target_unverified`, so a
 *    stored `verified` row is not evidence of anything — Cloud has just said
 *    otherwise, and believing our own cache over the upstream leaves a route broken
 *    forever. The cooldown, not the status, is what stops repeat work.
 * 2. Requesting a challenge RESETS the token upstream, so the previous one must keep
 *    being served: an older record may still be mid-re-probe, and answering only the
 *    newest would expire a verification that currently works.
 *
 * Everything is mocked at the wire boundary because that is where the risk isn't —
 * the logic is, and the real round-trip needs a publicly-reachable box plus Cloud
 * verification enabled for our namespace.
 */

const {
  findByTarget,
  recordChallenge,
  recordCheck,
  requestVerification,
  checkVerification,
  resolveTargetPlatform,
} = vi.hoisted(() => ({
  findByTarget: vi.fn(),
  recordChallenge: vi.fn(),
  recordCheck: vi.fn(),
  requestVerification: vi.fn(),
  checkVerification: vi.fn(),
  resolveTargetPlatform: vi.fn(),
}));

vi.mock("@repo/db", async () => {
  const { servableTokens } = await vi.importActual<
    typeof import("../../../../packages/db/src/repos/edge-target-verification.repo")
  >("../../../../packages/db/src/repos/edge-target-verification.repo");
  return {
    repos: {
      edgeTargetVerification: {
        findByTarget,
        recordChallenge,
        recordCheck,
        servableTokens,
      },
    },
  };
});
vi.mock("../../src/lib/cloud/client", () => ({
  cloudClient: () => ({ edgeProxy: { requestVerification, checkVerification } }),
}));
vi.mock("../../src/lib/deployment-runtime", () => ({ resolveTargetPlatform }));

import { ensureTargetVerified } from "../../src/lib/edge-target-verify";

const TARGET = "http://203.0.113.10";
const CHALLENGE = {
  id: 77,
  target: TARGET,
  status: "pending" as const,
  path: "/.well-known/oblien-proxy-challenge/tok-new",
  token: "tok-new",
};

let serveEdgeChallenge: ReturnType<typeof vi.fn>;
const routing = () => ({ serveEdgeChallenge }) as never;

/** The probe reads the token back over HTTP; default to the happy answer. */
function mockProbe(body: string | null, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      body === null
        ? { ok: false, status, text: async () => "" }
        : { ok: status < 400, status, text: async () => body },
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  serveEdgeChallenge = vi.fn(async () => ({ served: true, via: "challenge-vhost" }));
  findByTarget.mockResolvedValue(undefined);
  recordCheck.mockResolvedValue(undefined);
  recordChallenge.mockImplementation(async (data: Record<string, unknown>) => ({
    id: "etv_1",
    token: data.token,
    retiredTokens: ["tok-old"],
  }));
  requestVerification.mockResolvedValue(CHALLENGE);
  checkVerification.mockResolvedValue({
    id: 77,
    target: TARGET,
    status: "verified",
    validatedIp: "203.0.113.10",
    expiresAt: "2026-11-01T00:00:00.000Z",
  });
  mockProbe("tok-new");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ensureTargetVerified", () => {
  it("issues, serves, probes, checks and persists — in one pass", async () => {
    const r = await ensureTargetVerified("org-1", TARGET, { routing: routing() });

    expect(r).toEqual({ verified: true });
    expect(requestVerification).toHaveBeenCalledWith(TARGET);
    expect(recordChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        target: TARGET,
        host: "203.0.113.10",
        verificationId: 77,
        token: "tok-new",
        challengePath: CHALLENGE.path,
        status: "pending",
      }),
    );
    expect(recordCheck).toHaveBeenCalledWith("etv_1", {
      status: "verified",
      validatedIp: "203.0.113.10",
      expiresAt: new Date("2026-11-01T00:00:00.000Z"),
      lastError: null,
    });
  });

  it("serves the RETIRED tokens alongside the new one", async () => {
    // A re-request resets the token upstream while an older record may still be
    // probed. Answering only the newest expires a verification that works today —
    // and that failure surfaces ~83 days later with nothing in the logs.
    await ensureTargetVerified("org-1", TARGET, { routing: routing() });

    expect(serveEdgeChallenge).toHaveBeenCalledWith({
      host: "203.0.113.10",
      tokens: ["tok-new", "tok-old"],
    });
  });

  it("checks EXACTLY once — never polls", async () => {
    // The upstream allows 10 checks per 5 minutes and counts failures toward a
    // lockout, and a token that isn't being served won't start being served by
    // asking again.
    checkVerification.mockResolvedValue({ id: 77, target: TARGET, status: "pending" });

    const r = await ensureTargetVerified("org-1", TARGET, { routing: routing() });

    expect(checkVerification).toHaveBeenCalledTimes(1);
    expect(r.verified).toBe(false);
  });

  it("re-verifies a stored `verified` row once the cooldown has passed", async () => {
    // The reactive contract: the caller only gets here because Cloud refused the
    // sync. Trusting our own row would return success and leave the route dead.
    findByTarget.mockResolvedValue({
      id: "etv_1",
      status: "verified",
      lastCheckedAt: new Date(Date.now() - 10 * 60_000),
    });

    const r = await ensureTargetVerified("org-1", TARGET, { routing: routing() });

    expect(r.verified).toBe(true);
    expect(requestVerification).toHaveBeenCalled();
  });

  describe("cooldown", () => {
    it("reuses a very recent SUCCESS instead of re-issuing", async () => {
      // A 403 right after a green check is propagation, not a fresh problem, and
      // re-issuing would reset the token Cloud is in the middle of accepting.
      findByTarget.mockResolvedValue({
        id: "etv_1",
        status: "verified",
        lastCheckedAt: new Date(Date.now() - 5_000),
      });

      const r = await ensureTargetVerified("org-1", TARGET, { routing: routing() });

      expect(r).toEqual({ verified: true });
      expect(requestVerification).not.toHaveBeenCalled();
      expect(serveEdgeChallenge).not.toHaveBeenCalled();
    });

    it("reuses a very recent FAILURE, so one attempt decides for every domain", async () => {
      // Free-domain sync runs once PER DOMAIN in a loop. Without this, five free
      // domains on one target issue five challenges in a second — each resetting the
      // last — and walk into the upstream's rate limit.
      findByTarget.mockResolvedValue({
        id: "etv_1",
        status: "failed",
        lastError: "connection refused on port 80",
        lastCheckedAt: new Date(Date.now() - 5_000),
      });

      const r = await ensureTargetVerified("org-1", TARGET, { routing: routing() });

      expect(r).toEqual({ verified: false, reason: "connection refused on port 80" });
      expect(requestVerification).not.toHaveBeenCalled();
    });
  });

  describe("self-probe is advisory", () => {
    it("continues to the upstream check when it can't read the token back", async () => {
      // A box behind a NAT that won't hairpin its own public IP fails this while
      // being perfectly reachable from the internet. Gating on it would refuse
      // verifications that would have succeeded.
      mockProbe(null, 502);
      const onLog = vi.fn();

      const r = await ensureTargetVerified("org-1", TARGET, { routing: routing(), onLog });

      expect(checkVerification).toHaveBeenCalledTimes(1);
      expect(r.verified).toBe(true);
      expect(onLog).toHaveBeenCalledWith(expect.stringContaining("Continuing"), "warn");
    });

    it("treats a 200 carrying the WRONG body as a failure to serve", async () => {
      // A catch-all vhost, captive portal or CDN error page all answer 200. Reading
      // only the status would log success while Cloud's probe fails for a reason
      // nothing in our logs explains.
      mockProbe("<html>default site</html>");
      checkVerification.mockResolvedValue({
        id: 77,
        target: TARGET,
        status: "failed",
        error: "token mismatch",
      });

      const r = await ensureTargetVerified("org-1", TARGET, { routing: routing() });

      expect(r.selfProbeWarning).toMatch(/another server or vhost is answering/);
      expect(r.verified).toBe(false);
    });
  });

  describe("refusals", () => {
    it("stops before the upstream when the box has no HTTP surface to serve from", async () => {
      const r = await ensureTargetVerified("org-1", TARGET, { routing: { removeRoute: vi.fn() } as never });

      expect(r.verified).toBe(false);
      expect(r.reason).toMatch(/no HTTP surface/);
      expect(requestVerification).not.toHaveBeenCalled();
    });

    it("records a failure and skips the check when the challenge can't be installed", async () => {
      // Asking Cloud to probe a token we know isn't being served spends one of ten
      // checks per five minutes to learn nothing.
      serveEdgeChallenge = vi.fn(async () => ({ served: false, reason: "already served by legacy.conf" }));

      const r = await ensureTargetVerified("org-1", TARGET, { routing: routing() });

      expect(r).toEqual({ verified: false, reason: "already served by legacy.conf" });
      expect(checkVerification).not.toHaveBeenCalled();
      expect(recordCheck).toHaveBeenCalledWith("etv_1", {
        status: "failed",
        lastError: "already served by legacy.conf",
      });
    });

    it("surfaces the upstream's own reason verbatim", async () => {
      // Cloud's `error` names the actual cause — DNS, a firewall, a proxy in front
      // of :80 — and nothing we could substitute would be as specific.
      checkVerification.mockResolvedValue({
        id: 77,
        target: TARGET,
        status: "failed",
        error: "connection timed out after 5s",
      });

      const r = await ensureTargetVerified("org-1", TARGET, { routing: routing() });

      expect(r.reason).toBe("connection timed out after 5s");
      expect(recordCheck).toHaveBeenCalledWith(
        "etv_1",
        expect.objectContaining({ status: "failed", lastError: "connection timed out after 5s" }),
      );
    });

    it("reports a missing Cloud link as such, not as a verification failure", async () => {
      requestVerification.mockResolvedValue(null);

      const r = await ensureTargetVerified("org-1", TARGET, { routing: routing() });

      expect(r.reason).toMatch(/not connected/);
      expect(recordChallenge).not.toHaveBeenCalled();
    });

    it("rejects a target with no usable host before calling anything", async () => {
      const r = await ensureTargetVerified("org-1", "", { routing: routing() });

      expect(r).toEqual({ verified: false, reason: "no target to verify" });
      expect(findByTarget).not.toHaveBeenCalled();
    });

    it("never throws when the upstream does — a free URL is a warning, not a deploy failure", async () => {
      requestVerification.mockRejectedValue(new Error("502 from cloud"));

      await expect(
        ensureTargetVerified("org-1", TARGET, { routing: routing() }),
      ).resolves.toMatchObject({ verified: false, reason: "502 from cloud" });
    });
  });

  it("canonicalizes the target it verifies, so it matches the one that gets routed", async () => {
    // Cloud keys the row on a normalized `scheme://host:port`; verifying a bare host
    // and routing a URL (or vice versa) is a permanent `target_unverified`.
    await ensureTargetVerified("org-1", "203.0.113.10:80", { routing: routing() });

    expect(requestVerification).toHaveBeenCalledWith(TARGET);
    expect(recordChallenge).toHaveBeenCalledWith(expect.objectContaining({ target: TARGET }));
  });

  it("resolves routing for the target's own box when the caller didn't supply it", async () => {
    // Deploy callers don't hold it and building a platform isn't free, so this stays
    // lazy — reached only once a verification is actually needed.
    resolveTargetPlatform.mockResolvedValue({ routing: routing() });

    const r = await ensureTargetVerified("org-1", TARGET, { serverId: "srv-9" });

    expect(resolveTargetPlatform).toHaveBeenCalledWith("server", "docker", "srv-9", "org-1");
    expect(r.verified).toBe(true);
  });
});
