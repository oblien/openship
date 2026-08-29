import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `ensureManagedEdgeProxy` is THE one funnel for wiring a free `<slug>.opsh.io`
 * route, and the verify-and-retry lives here for a reason: Openship Cloud refuses to
 * route to a target whose control hasn't been proven, so `403 target_unverified` is
 * not a failure — it is the signal to prove it. A second copy of this call anywhere
 * (the setup wizard used to have one) is a path that never verifies and dies on that
 * refusal.
 *
 * `CloudRequestError` is NOT mocked here: that the code survives the box↔SaaS hop as
 * a field rather than a substring of a sentence is the thing being tested.
 */

const { resolveEdgeTargetHost, sync, ensureTargetVerified } = vi.hoisted(() => ({
  resolveEdgeTargetHost: vi.fn(),
  sync: vi.fn(),
  ensureTargetVerified: vi.fn(),
}));

vi.mock("../../src/lib/cloud/client", () => ({
  cloudClient: () => ({ edgeProxy: { sync } }),
}));
vi.mock("../../src/lib/edge-target", () => ({
  resolveEdgeTargetHost,
  canonicalEdgeTarget: (h: string) => (/^https?:\/\//.test(h) ? h : `http://${h}`),
}));
vi.mock("../../src/lib/edge-target-verify", () => ({ ensureTargetVerified }));

import { CloudRequestError } from "../../src/lib/cloud/request-error";
import { ensureManagedEdgeProxy, ManagedEdgeError } from "../../src/lib/managed-edge-proxy";

const unverified = () =>
  new CloudRequestError("Edge proxy sync failed (403): target_unverified", {
    status: 403,
    code: "target_unverified",
  });

beforeEach(() => {
  vi.clearAllMocks();
  resolveEdgeTargetHost.mockResolvedValue({ host: "203.0.113.10" });
  sync.mockResolvedValue({ ok: true });
  ensureTargetVerified.mockResolvedValue({ verified: true });
});

afterEach(() => vi.restoreAllMocks());

describe("ensureManagedEdgeProxy", () => {
  it("never touches the verification code on the happy path", async () => {
    // Verification must be invisible when it isn't needed — it is not on the hot
    // path of every deploy.
    const r = await ensureManagedEdgeProxy("org-1", "myapp");

    expect(r).toEqual({ target: "203.0.113.10", warning: undefined });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(ensureTargetVerified).not.toHaveBeenCalled();
  });

  it("verifies and retries the sync exactly ONCE on target_unverified", async () => {
    sync.mockRejectedValueOnce(unverified());

    const r = await ensureManagedEdgeProxy("org-1", "myapp", { serverId: "srv-9" });

    expect(r.target).toBe("203.0.113.10");
    expect(ensureTargetVerified).toHaveBeenCalledWith(
      "org-1",
      "http://203.0.113.10",
      expect.objectContaining({ serverId: "srv-9" }),
    );
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("verifies the CANONICAL form of the host it is about to route", async () => {
    // Cloud matches the verification row on a normalized `scheme://host:port`, so
    // verifying a bare host and routing a URL is a permanent `target_unverified`.
    sync.mockRejectedValueOnce(unverified());

    await ensureManagedEdgeProxy("org-1", "myapp");

    expect(ensureTargetVerified).toHaveBeenCalledWith("org-1", "http://203.0.113.10", expect.anything());
    expect(sync).toHaveBeenLastCalledWith({ slug: "myapp", target: "203.0.113.10" });
  });

  it("does not retry when verification fails, and says what is wrong", async () => {
    sync.mockRejectedValue(unverified());
    ensureTargetVerified.mockResolvedValue({ verified: false, reason: "connection timed out" });

    await expect(ensureManagedEdgeProxy("org-1", "myapp")).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("connection timed out"),
    });
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("does NOT verify on any other failure", async () => {
    // Verifying in response to, say, a 500 spends an upstream challenge (which
    // resets the token) on a problem verification cannot fix.
    sync.mockRejectedValue(new CloudRequestError("Edge proxy sync failed (500)", { status: 500 }));

    await expect(ensureManagedEdgeProxy("org-1", "myapp")).rejects.toBeInstanceOf(ManagedEdgeError);
    expect(ensureTargetVerified).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  describe("the three failures the caller has to answer differently", () => {
    it("400 for an unresolvable target — the operator's config", async () => {
      resolveEdgeTargetHost.mockResolvedValue({ host: null, reason: "no public address is set" });

      await expect(ensureManagedEdgeProxy("org-1", "myapp")).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("no public address is set"),
      });
      expect(sync).not.toHaveBeenCalled();
    });

    it("409 when no member has linked Openship Cloud — a setup step", async () => {
      sync.mockResolvedValue(null);

      await expect(ensureManagedEdgeProxy("org-1", "myapp")).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("linked Openship Cloud"),
      });
    });

    it("502 for an upstream refusal — neither of the above", async () => {
      sync.mockRejectedValue(new Error("socket hang up"));

      await expect(ensureManagedEdgeProxy("org-1", "myapp")).rejects.toMatchObject({
        status: 502,
        message: "socket hang up",
      });
    });
  });

  it("returns the target and its caveat so the caller can SHOW them", async () => {
    // The target is the whole substance of the route and used to be invisible
    // everywhere — on the box, in the deploy log and in the Domains tab alike.
    resolveEdgeTargetHost.mockResolvedValue({
      host: "box.example.com",
      warning: "pointed at a hostname rather than an IP",
    });

    const r = await ensureManagedEdgeProxy("org-1", "myapp");

    expect(r).toEqual({ target: "box.example.com", warning: "pointed at a hostname rather than an IP" });
  });

  it("no-ops on an empty slug without resolving or calling anything", async () => {
    expect(await ensureManagedEdgeProxy("org-1", "  ")).toEqual({ target: "" });
    expect(resolveEdgeTargetHost).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
});
