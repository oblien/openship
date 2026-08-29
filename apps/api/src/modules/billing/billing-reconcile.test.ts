import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Entitlement reconciliation — the safety net for everything the webhooks miss.
 *
 * Oblien states that webhook "delivery is best-effort" and tells callers to
 * reconcile. Before this existed a single dropped `credits.depleted` left an org
 * reading `active` forever, with its workloads stopped and its billing page
 * claiming health. It also stands in for `namespace.suspended` /
 * `namespace.restored`, which SDK 2.2.45's `WebhookEvent` union cannot subscribe to.
 *
 * The case that matters most is `quotaMissing`: a namespace that exists on Oblien
 * with no compute quota row is a tenant burning metered compute with nothing
 * stopping it.
 */

const h = vi.hoisted(() => ({
  org: null as Record<string, unknown> | null,
  details: {} as { data?: { status?: string; quotas?: unknown[] } },
  detailsThrows: null as Error | null,
  setSubscriptionStatus: vi.fn(async () => {}),
  getDetails: vi.fn(),
  // Asserted against directly instead of stubbing `setQuotaForTier`: the reconciler
  // calls it through its own module-local binding, which a self-mock cannot
  // intercept under ESM. Watching the SDK call is the stronger assertion anyway —
  // it proves the ceiling really reached Oblien.
  setQuota: vi.fn(async () => ({})),
  nsUpdate: vi.fn(async () => ({})),
}));

vi.mock("../../config/env", () => ({
  env: { CLOUD_MODE: true, OBLIEN_CLIENT_ID: "cid", OBLIEN_CLIENT_SECRET: "csec" },
}));
vi.mock("@repo/db", () => ({
  repos: {
    organization: {
      findById: async () => h.org,
      setSubscriptionStatus: h.setSubscriptionStatus,
    },
  },
}));
vi.mock("../../lib/oblien-client", () => ({
  getOblienClient: () => ({
    namespaces: {
      getDetails: h.getDetails,
      setQuota: h.setQuota,
      update: h.nsUpdate,
    },
  }),
}));

import { reconcileOblienEntitlement } from "./billing-oblien-quota";

/** starter = 150,000 compute + 3,000 build×8 = 174,000 units → 174,000,000 milli */
const STARTER_MILLI = 174_000_000;
const STARTER_OBLIEN_CREDITS = STARTER_MILLI / 1000;

describe("reconcileOblienEntitlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.org = {
      id: "org_1",
      oblienNamespace: "os-1",
      planTierId: "starter",
      subscriptionStatus: "active",
    };
    h.getDetails.mockImplementation(async () => {
      if (h.detailsThrows) throw h.detailsThrows;
      return h.details;
    });
    h.detailsThrows = null;
    h.details = {
      data: {
        status: "active",
        quotas: [{ service: "compute", quota_limit: STARTER_OBLIEN_CREDITS, quota_used: 10 }],
      },
    };
  });

  it("reports no drift when Oblien already matches the tier", async () => {
    const drift = await reconcileOblienEntitlement("org_1");
    expect(drift?.changed).toBe(false);
    expect(drift?.quotaMissing).toBe(false);
    expect(h.setQuota).not.toHaveBeenCalled();
  });

  it("flags and repairs an UNCAPPED tenant — a namespace with no quota row", async () => {
    h.details = { data: { status: "active", quotas: [] } };
    const drift = await reconcileOblienEntitlement("org_1");
    expect(drift?.quotaMissing).toBe(true);
    expect(drift?.changed).toBe(true);
    expect(h.setQuota).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "os-1", quotaLimit: STARTER_OBLIEN_CREDITS }),
    );
  });

  it("re-pushes a ceiling that disagrees with the tier", async () => {
    h.details = {
      data: { status: "active", quotas: [{ service: "compute", quota_limit: 99, quota_used: 0 }] },
    };
    const drift = await reconcileOblienEntitlement("org_1");
    expect(drift?.quotaLimitWas).toBe(99_000);
    expect(drift?.quotaLimitNow).toBe(STARTER_MILLI);
    expect(h.setQuota).toHaveBeenCalledWith(
      expect.objectContaining({ quotaLimit: STARTER_OBLIEN_CREDITS }),
    );
  });

  it("marks an org exhausted when Oblien says the namespace is suspended", async () => {
    h.details = {
      data: {
        status: "suspended",
        quotas: [{ service: "compute", quota_limit: STARTER_OBLIEN_CREDITS, quota_used: 999 }],
      },
    };
    const drift = await reconcileOblienEntitlement("org_1");
    // This is the dropped-webhook case: nothing told us, we found out by looking.
    expect(h.setSubscriptionStatus).toHaveBeenCalledWith("org_1", "credit_exhausted");
    expect(drift?.statusNow).toBe("credit_exhausted");
  });

  it("clears credit_exhausted once Oblien reports the namespace active again", async () => {
    h.org = { ...h.org, subscriptionStatus: "credit_exhausted" };
    await reconcileOblienEntitlement("org_1");
    expect(h.setSubscriptionStatus).toHaveBeenCalledWith("org_1", "active");
  });

  it("NEVER overwrites a Stripe-owned status, even when Oblien reports suspended", async () => {
    // The scenario has to be SUSPENDED, not active. With Oblien active the target
    // computation already resolves to null for these statuses, so an active-namespace
    // case passes whether the guard exists or not — it proves nothing. Suspended is
    // where the guard bites: without it, `past_due` would be overwritten with
    // `credit_exhausted` and the org's real problem (the card failed) would vanish
    // from the billing page.
    for (const status of ["past_due", "canceled", "unpaid"]) {
      vi.clearAllMocks();
      h.org = { ...h.org, subscriptionStatus: status };
      h.details = {
        data: {
          status: "suspended",
          quotas: [{ service: "compute", quota_limit: STARTER_OBLIEN_CREDITS, quota_used: 999 }],
        },
      };
      const drift = await reconcileOblienEntitlement("org_1");
      expect(h.setSubscriptionStatus, status).not.toHaveBeenCalled();
      expect(drift?.statusNow, status).toBe(status);
    }
  });

  it("leaves enterprise uncapped instead of 'repairing' it into a ceiling", async () => {
    h.org = { ...h.org, planTierId: "enterprise" };
    h.details = { data: { status: "active", quotas: [] } };
    const drift = await reconcileOblienEntitlement("org_1");
    // monthlyCredits === null is a negotiated contract, not a missing ceiling.
    expect(h.setQuota).not.toHaveBeenCalled();
    expect(drift?.changed).toBe(false);
  });

  it("skips an org with no namespace rather than inventing one", async () => {
    h.org = { ...h.org, oblienNamespace: null };
    expect(await reconcileOblienEntitlement("org_1")).toBeNull();
    expect(h.getDetails).not.toHaveBeenCalled();
  });

  it("survives an unreachable namespace — one bad org must not stop the sweep", async () => {
    h.detailsThrows = new Error("oblien 502");
    await expect(reconcileOblienEntitlement("org_1")).resolves.toBeNull();
  });
});
