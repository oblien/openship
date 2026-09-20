import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  org: { id: "org_1", oblienNamespace: "os-1" as string | null },
  findById: vi.fn(),
  assertPolicy: vi.fn(),
  defaults: vi.fn(),
  tokens: vi.fn(),
  ensure: vi.fn(),
  persist: vi.fn(),
  stores: new Map<string, Map<string, unknown>>(),
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { CLOUD_MODE: true, OBLIEN_API_URL: "https://api.oblien.com" } }));
vi.mock("@repo/db", () => ({
  repos: { organization: { findById: h.findById, setOblienNamespace: h.persist } },
  withAdvisoryLock: async (_key: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("@repo/platform/engine/lib/cache-store/index", () => ({
  cacheStore: async (namespace: string) => {
    if (!h.stores.has(namespace)) h.stores.set(namespace, new Map());
    const map = h.stores.get(namespace)!;
    return {
      get: async (key: string) => map.get(key) ?? null,
      set: async (key: string, value: unknown) => { map.set(key, value); },
      invalidateByPrefix: async () => { map.clear(); },
    };
  },
}));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienClient: () => ({ namespaces: { ensure: h.ensure }, tokens: { create: h.tokens } }),
}));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({
  assertNamespaceHasQuota: h.assertPolicy, ensureOblienDefaultQuota: h.defaults,
}));
vi.mock("@repo/platform/engine/lib/cloud-resource-limits", () => ({
  initialCloudNamespaceLimits: async () => ({ max_workspaces: 2, max_vcpus: 4, max_ram_mb: 8192, max_disk_gb: 32 }),
}));

import { ensureNamespace, ensureNamespaceWithQuota, issueNamespaceToken, namespaceSlugForOrg } from "@repo/platform/engine/lib/openship-cloud";

beforeEach(() => {
  vi.resetAllMocks();
  h.stores.clear();
  h.org = { id: "org_1", oblienNamespace: "os-1" };
  h.findById.mockImplementation(async () => ({ ...h.org }));
  h.ensure.mockImplementation(async ({ slug }) => ({ data: { slug } }));
  h.tokens.mockResolvedValue({ token: "tenant-token", expiresAt: "2026-10-01T00:00:00Z" });
});

describe("cloud namespace and billing boundary", () => {
  it("checks provider policy even for an already recorded namespace", async () => {
    expect(await ensureNamespaceWithQuota("org_1")).toBe("os-1");
    expect(h.assertPolicy).toHaveBeenCalledWith("org_1");
    expect(h.ensure).not.toHaveBeenCalled();
  });
  it("issues no token if entitlement verification fails, and retries next time", async () => {
    h.assertPolicy.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(issueNamespaceToken("org_1")).rejects.toThrow("provider unavailable");
    expect(h.tokens).not.toHaveBeenCalled();
    await issueNamespaceToken("org_1");
    expect(h.assertPolicy).toHaveBeenCalledTimes(2);
    expect(h.tokens).toHaveBeenCalledWith({ scope: "namespace", namespace: "os-1", ttl: 1800 });
  });
  it("does not create provider resources when the organization lookup fails", async () => {
    h.findById.mockRejectedValue(new Error("database unavailable"));
    await expect(ensureNamespace("org_1")).rejects.toThrow("database unavailable");
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.tokens).not.toHaveBeenCalled();
  });
  it("does not mint a token when ownership cannot be persisted", async () => {
    h.org.oblienNamespace = null;
    h.persist.mockRejectedValue(new Error("database unavailable"));
    await expect(issueNamespaceToken("org_1")).rejects.toThrow("database unavailable");
    expect(h.tokens).not.toHaveBeenCalled();
    expect(h.stores.get("oblien-namespaces")?.size).toBe(0);
  });
  it("checks onboarding defaults before creating a new namespace", async () => {
    h.org.oblienNamespace = null;
    h.defaults.mockRejectedValue(new Error("uncapped default policy"));
    await expect(ensureNamespace("org_1")).rejects.toThrow("uncapped default policy");
    expect(h.ensure).not.toHaveBeenCalled();
  });
  it("creates new namespaces with finite provider resource ceilings", async () => {
    h.org.oblienNamespace = null;
    await ensureNamespace("org_1");
    expect(h.ensure).toHaveBeenCalledWith(expect.objectContaining({
      resource_limits: { max_workspaces: 2, max_vcpus: 4, max_ram_mb: 8192, max_disk_gb: 32 },
    }));
  });
  it("never aliases organizations through prefix stripping or case folding", () => {
    expect(new Set(["org_A", "org_a", "A", "org.a", "org-a"].map(namespaceSlugForOrg)).size).toBe(5);
  });
  it("rejects an unexpected namespace from the provider", async () => {
    h.org.oblienNamespace = null;
    h.ensure.mockResolvedValue({ data: { slug: "another-customer" } });
    await expect(issueNamespaceToken("org_1")).rejects.toMatchObject({ code: "CLOUD_NAMESPACE_MISMATCH" });
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.tokens).not.toHaveBeenCalled();
  });
});
