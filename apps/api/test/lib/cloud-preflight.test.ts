import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ namespace: vi.fn(), routes: vi.fn(), checkSlug: vi.fn(), verify: vi.fn(), scopedVerify: vi.fn(), spend: vi.fn() }));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { OBLIEN_API_URL: "https://api.oblien.com" } }));
vi.mock("@repo/platform/engine/lib/routing-domains", () => ({ getRoutingBaseDomain: () => "opsh.io" }));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({
  getNamespaceClient: h.namespace, ensureNamespace: async () => "ns-a",
  getOblienClient: () => ({ domain: { routes: h.routes, checkSlug: h.checkSlug, verify: h.verify } }),
}));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({ assertCloudCanSpend: h.spend }));
import { runCloudPreflight } from "@repo/platform/engine/lib/cloud-preflight";

beforeEach(() => {
  vi.resetAllMocks();
  h.namespace.mockResolvedValue({ namespace: "ns-a", client: { domain: { verify: h.scopedVerify } } });
  h.checkSlug.mockResolvedValue({ available: false });
  h.routes.mockResolvedValue({ data: [{ namespace: "ns-a", hostname: "site.opsh.io", owner_type: "page" }] });
});
describe("Cloud preflight", () => {
  it("verifies DNS using the selected managed server namespace", async () => {
    h.scopedVerify.mockResolvedValue({ verified: true, cname: true, ownership: true });
    expect(await runCloudPreflight("org-a", { customDomain: "app.example.com", workspaceId: "workspace-a" })).toMatchObject({
      runtime: { ok: true },
      customDomain: { verified: true, cname: true, ownership: true },
    });
    expect(h.namespace).toHaveBeenCalledWith("org-a", "workspace-a");
    expect(h.spend).toHaveBeenCalledWith("org-a", "workspace-a");
    expect(h.scopedVerify).toHaveBeenCalledWith({ domain: "app.example.com" });
    expect(h.verify).not.toHaveBeenCalled();
  });
  it("preserves the provider's missing DNS and ownership records", async () => {
    const records = {
      cname: { host: "app.example.com", target: "edge.example.com" },
      txt: { host: "_opsh.app.example.com", value: "verify=resource" },
    };
    h.scopedVerify.mockResolvedValue({
      verified: false,
      cname: false,
      ownership: false,
      errors: [],
      required_records: records,
    });
    const result = await runCloudPreflight("org-a", { customDomain: "app.example.com" });
    expect(result.customDomain).toMatchObject({ verified: false, requiredRecords: records });
    expect(result.customDomain?.message).toContain("CNAME app.example.com → edge.example.com");
    expect(result.customDomain?.message).toContain("TXT _opsh.app.example.com = verify=resource");
  });
  it("does not start DNS checks after tenant entitlement fails", async () => {
    h.spend.mockRejectedValue(new Error("Cloud credits exhausted"));
    const result = await runCloudPreflight("org-a", { customDomain: "app.example.com" });
    expect(result.runtime.ok).toBe(false);
    expect(result.customDomain?.verified).toBe(false);
    expect(h.scopedVerify).not.toHaveBeenCalled();
  });
  it("does not blame DNS or expose provider errors when verification is unavailable", async () => {
    h.scopedVerify.mockRejectedValue(new Error("scope_denied: internal provider details"));
    expect(
      (await runCloudPreflight("org-a", { customDomain: "app.example.com" })).customDomain,
    ).toEqual({
      verified: false,
      message: "Couldn't verify app.example.com right now. Please retry.",
    });
  });
  it("uses a tenant platform and recognizes an existing Pages hostname", async () => {
    expect(await runCloudPreflight("org-a", { slug: "site" })).toMatchObject({ runtime: { ok: true }, slug: { available: true } });
    expect(h.namespace).toHaveBeenCalledWith("org-a", undefined);
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
  });
  it("identifies a namespace capacity refusal as a deployment check failure", async () => {
    h.namespace.mockRejectedValue(Object.assign(new Error("The configured Cloud limits exceed the provider account's resource capacity. Contact Openship support."), { code: "plan_limit_exceeded", status: 400 }));
    const result = await runCloudPreflight("org-a", {});
    expect(result.runtime).toEqual({ ok: false, message: "Cloud deployment check failed: The configured Cloud limits exceed the provider account's resource capacity. Contact Openship support." });
    expect(h.spend).not.toHaveBeenCalled();
  });
  it("prompts for routing only when the parent already proves ownership", async () => {
    h.scopedVerify.mockResolvedValue({
      verified: false,
      cname: false,
      ownership: true,
      required_records: {
        cname: { host: "app.example.com", target: "edge.example.com" },
        txt: { host: "_opsh.example.com", value: "verify=parent" },
      },
    });
    const { customDomain } = await runCloudPreflight("org-a", { customDomain: "app.example.com" });
    expect(customDomain?.requiredRecords?.cname).toEqual({ host: "app.example.com", target: "edge.example.com" });
    expect(customDomain?.requiredRecords?.txt).toBeUndefined();
    expect(customDomain?.message).not.toContain("TXT");
  });
});
