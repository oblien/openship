import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ token: vi.fn(), routes: vi.fn(), checkSlug: vi.fn(), spend: vi.fn(), createPlatform: vi.fn(), quota: vi.fn() }));
vi.mock("@repo/adapters", () => ({ createPlatform: h.createPlatform }));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { OBLIEN_API_URL: "https://api.oblien.com" } }));
vi.mock("@repo/platform/engine/lib/routing-domains", () => ({ getRoutingBaseDomain: () => "opsh.io" }));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({
  issueNamespaceToken: h.token, ensureNamespace: async () => "ns-a",
  getOblienClient: () => ({ domain: { routes: h.routes, checkSlug: h.checkSlug } }),
}));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({ assertCloudCanSpend: h.spend }));
import { runCloudPreflight } from "@repo/platform/engine/lib/cloud-preflight";

beforeEach(() => {
  vi.resetAllMocks();
  h.token.mockResolvedValue({ namespace: "ns-a", token: "test-namespace-token" });
  h.createPlatform.mockResolvedValue({ runtime: { getQuota: h.quota } });
  h.checkSlug.mockResolvedValue({ available: false });
  h.routes.mockResolvedValue({ data: [{ namespace: "ns-a", hostname: "site.opsh.io", owner_type: "page" }] });
});
describe("Cloud preflight", () => {
  it("uses a tenant platform and recognizes an existing Pages hostname", async () => {
    expect(await runCloudPreflight("org-a", { slug: "site" })).toMatchObject({ runtime: { ok: true }, slug: { available: true } });
    expect(h.createPlatform).toHaveBeenCalledWith(expect.objectContaining({ cloudNamespace: "ns-a", cloudToken: "test-namespace-token" }));
    expect(h.routes).toHaveBeenCalledWith({ namespace: "ns-a" });
    expect(h.spend).toHaveBeenCalledWith("org-a", undefined);
  });
  it("does not consider another namespace's hostname available", async () => {
    h.routes.mockResolvedValue({ data: [{ namespace: "ns-b", hostname: "site.opsh.io" }] });
    expect(await runCloudPreflight("org-a", { slug: "site" })).toMatchObject({ slug: { available: false } });
  });
  it("shows a billing refusal before starting billable work", async () => {
    h.spend.mockRejectedValue(new Error("Cloud credits exhausted"));
    expect(await runCloudPreflight("org-a", {})).toMatchObject({ runtime: { ok: false, message: expect.stringContaining("credits exhausted") } });
    expect(h.createPlatform).not.toHaveBeenCalled();
  });
  it("identifies a namespace capacity refusal as a deployment check failure", async () => {
    h.token.mockRejectedValue(Object.assign(new Error("The configured Cloud limits exceed the provider account's resource capacity. Contact Openship support."), { code: "plan_limit_exceeded", status: 400 }));
    const result = await runCloudPreflight("org-a", {});
    expect(result.runtime).toEqual({ ok: false, message: "Cloud deployment check failed: The configured Cloud limits exceed the provider account's resource capacity. Contact Openship support." });
    expect(h.createPlatform).not.toHaveBeenCalled();
    expect(h.spend).not.toHaveBeenCalled();
  });
  it("does not block an entitled customer on the account-level workspace quota endpoint", async () => {
    h.quota.mockRejectedValue(new Error("Account quota is unavailable for scoped tokens"));
    expect(await runCloudPreflight("org-a", {})).toMatchObject({ runtime: { ok: true } });
    expect(h.spend).toHaveBeenCalledWith("org-a", undefined);
    expect(h.quota).not.toHaveBeenCalled();
  });
});
