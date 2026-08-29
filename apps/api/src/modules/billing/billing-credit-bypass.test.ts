import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The credit-bypass guard.
 *
 * These tests exist because of a specific, shipped hole. `ensureNamespace` returns
 * early the moment `organization.oblien_namespace` is set and never touches quota.
 * Org creation pairs namespace + quota via `provisionOrgNamespace`, but that call is
 * fire-and-forget in `auth.ts` so a slow Oblien can't fail signup — and when it
 * failed, the first deploy called bare `ensureNamespace`, which CREATED and RECORDED
 * the namespace with no ceiling. Every later call then hit the early return and the
 * boot backfill skipped the org (it has a namespace, so it looks provisioned). The
 * tenant ran fully metered, uncapped, indefinitely.
 *
 * So the property under test is not "setQuota gets called somewhere". It is: you
 * cannot obtain a namespace to spend against unless the ceiling was asserted first,
 * and if it can't be asserted you get nothing.
 */

const h = vi.hoisted(() => ({
  org: null as { id: string; oblienNamespace: string | null; planTierId: string } | null,
  setQuotaForTier: vi.fn(async () => {}),
  tokensCreate: vi.fn(async () => ({ token: "tok_1", expiresAt: "2026-01-01T00:00:00Z" })),
  namespacesEnsure: vi.fn(async () => ({ data: { slug: "os-1" } })),
  setOblienNamespace: vi.fn(async () => {}),
  cacheGet: vi.fn(async () => null as string | null),
  cacheSet: vi.fn(async () => {}),
  // Real Map-backed store for the assertion memo, NOT a stub that always misses:
  // "asserts once, not on every call" is only a meaningful test if a set is
  // actually visible to the next get.
  memo: new Map<string, unknown>(),
}));

vi.mock("../../config/env", () => ({
  env: {
    CLOUD_MODE: true,
    OBLIEN_CLIENT_ID: "cid_test",
    OBLIEN_CLIENT_SECRET: "csec_test",
  },
}));
vi.mock("@repo/db", () => ({
  repos: {
    organization: {
      findById: async () => h.org,
      setOblienNamespace: h.setOblienNamespace,
    },
  },
}));
vi.mock("../../lib/cache-store", () => ({
  cacheStore: async (ns: string) =>
    ns === "oblien-quota-asserted"
      ? {
          get: async (k: string) => h.memo.get(k) ?? null,
          set: async (k: string, v: unknown) => void h.memo.set(k, v),
          invalidateByPrefix: async () => h.memo.clear(),
        }
      : { get: h.cacheGet, set: h.cacheSet },
}));
// Mocked at the SDK boundary, not with a spy on `getOblienClient`: that function is
// called through the module's own local binding, so spying on the export would not
// intercept it.
vi.mock("@repo/adapters", () => ({
  Oblien: class {
    namespaces = { ensure: h.namespacesEnsure };
    tokens = { create: h.tokensCreate };
  },
}));
// The quota wrapper is reached through a DYNAMIC import inside
// ensureNamespaceWithQuota (it imports getOblienClient from openship-cloud, so a
// static import would be a cycle). vi.mock intercepts it either way.
vi.mock("./billing-oblien-quota", () => ({ setQuotaForTier: h.setQuotaForTier }));

import {
  ensureNamespaceWithQuota,
  issueNamespaceToken,
  __resetQuotaAssertedForTests,
} from "../../lib/openship-cloud";

describe("credit bypass — namespace cannot precede its ceiling", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await __resetQuotaAssertedForTests();
    h.org = { id: "org_1", oblienNamespace: "os-1", planTierId: "starter" };
    h.setQuotaForTier.mockImplementation(async () => {});
  });

  it("asserts the ceiling even when the namespace is ALREADY recorded", async () => {
    // The exact bypass shape: the row already has a namespace, so `ensureNamespace`
    // short-circuits. If the assertion rode along with namespace *creation* only,
    // this org would stay uncapped forever.
    await ensureNamespaceWithQuota("org_1");
    expect(h.setQuotaForTier).toHaveBeenCalledWith("org_1", "starter");
  });

  it("refuses to hand back a namespace when the ceiling cannot be set", async () => {
    h.setQuotaForTier.mockRejectedValueOnce(new Error("oblien 503"));
    await expect(ensureNamespaceWithQuota("org_1")).rejects.toThrow(/oblien 503/);
  });

  it("does not mark the org asserted after a failed push, so the next call retries", async () => {
    h.setQuotaForTier.mockRejectedValueOnce(new Error("oblien 503"));
    await expect(ensureNamespaceWithQuota("org_1")).rejects.toThrow();

    // A memo written before the write succeeded would make the retry a no-op and
    // leave the tenant uncapped for the life of the process.
    await ensureNamespaceWithQuota("org_1");
    expect(h.setQuotaForTier).toHaveBeenCalledTimes(2);
  });

  it("asserts once per TTL window, not on every call", async () => {
    await ensureNamespaceWithQuota("org_1");
    await ensureNamespaceWithQuota("org_1");
    await ensureNamespaceWithQuota("org_1");
    expect(h.setQuotaForTier).toHaveBeenCalledTimes(1);
  });

  it("falls back to the FREE tier when the org's tier is unreadable", async () => {
    h.org = { id: "org_1", oblienNamespace: "os-1", planTierId: null as unknown as string };
    await ensureNamespaceWithQuota("org_1");
    // Smallest ceiling is the safe direction for an unknown tier.
    expect(h.setQuotaForTier).toHaveBeenCalledWith("org_1", "free");
  });

  it("mints no deploy token until the ceiling is asserted", async () => {
    h.setQuotaForTier.mockRejectedValueOnce(new Error("oblien down"));
    await expect(issueNamespaceToken("org_1")).rejects.toThrow(/oblien down/);
    // The token is full namespace authority — create workspaces, deploy, run.
    // Handing one out before the ceiling exists IS the bypass.
    expect(h.tokensCreate).not.toHaveBeenCalled();
  });

  it("mints a token once the ceiling is in place", async () => {
    const res = await issueNamespaceToken("org_1");
    expect(h.setQuotaForTier).toHaveBeenCalledOnce();
    expect(h.tokensCreate).toHaveBeenCalledOnce();
    expect(res.namespace).toBe("os-1");
  });
});
