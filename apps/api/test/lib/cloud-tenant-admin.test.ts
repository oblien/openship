import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pageGet: vi.fn(), pageCreate: vi.fn(), pageDelete: vi.fn(), pageDisable: vi.fn(), pageDeploy: vi.fn(),
  workspaceGet: vi.fn(), routes: vi.fn(), setRoutes: vi.fn(), spend: vi.fn(), pageList: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({ getOblienClient: () => ({
  workspaces: { get: h.workspaceGet },
  pages: { list: h.pageList, get: h.pageGet, create: h.pageCreate, delete: h.pageDelete, disable: h.pageDisable, deploy: h.pageDeploy },
  domain: { routes: h.routes }, routes: { set: h.setRoutes },
}) }));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({ assertCloudCanSpend: h.spend }));
import { createTenantCloudAdmin } from "@repo/platform/engine/lib/cloud-tenant-admin";

beforeEach(() => {
  vi.resetAllMocks();
  h.workspaceGet.mockImplementation(async (id) => ({ id, namespace: id === "ws-own" ? "ns-own" : "ns-other" }));
  h.pageGet.mockImplementation(async (slug) => ({ page: { slug, namespace: slug === "own-page" ? "ns-own" : "ns-other" } }));
  h.routes.mockResolvedValue({ success: true, data: [
    { hostname: "own.opsh.io", namespace: "ns-own" }, { hostname: "other.opsh.io", namespace: "ns-other" },
  ] });
});
describe("admin-only cloud delegation", () => {
  it("lists only this customer's Pages, resolving summaries before returning them", async () => {
    h.pageList.mockResolvedValue({ success: true, pages: [{ slug: "own-page" },
      { slug: "foreign-summary" }, { slug: "other-page", namespace: "ns-other" }] });
    expect(await createTenantCloudAdmin("org-one", "ns-own").pages!.list()).toEqual({
      success: true, pages: [{ slug: "own-page", namespace: "ns-own" }],
    });
    expect(h.pageGet).not.toHaveBeenCalledWith("other-page");
    expect(h.spend).not.toHaveBeenCalled();
  });
  it("rejects another customer's workspace before exporting a page", async () => {
    const proxy = createTenantCloudAdmin("org-one", "ns-own");
    await expect(proxy.createPage({ workspace_id: "ws-other", path: "/app/dist", name: "test", slug: "test" })).rejects.toMatchObject({ statusCode: 404 });
    expect(h.pageCreate).not.toHaveBeenCalled();
  });
  it("pins page creation to the authenticated namespace", async () => {
    const proxy = createTenantCloudAdmin("org-one", "ns-own");
    await proxy.pages!.create({ workspace_id: "ws-own", path: "/app/dist", name: "test", slug: "test", namespace: "ns-other" });
    expect(h.pageCreate).toHaveBeenCalledWith(expect.objectContaining({ namespace: "ns-own" }));
    expect(h.spend).toHaveBeenCalledWith("org-one");
  });
  it("cannot read, replace or delete another customer's page", async () => {
    const pages = createTenantCloudAdmin("org-one", "ns-own").pages!;
    await expect(pages.get("other-page")).rejects.toMatchObject({ statusCode: 404 });
    await expect(pages.delete("other-page")).rejects.toMatchObject({ statusCode: 404 });
    await expect(pages.deploy("other-page", { workspace_id: "ws-own", path: "/app/dist" })).rejects.toMatchObject({ statusCode: 404 });
    expect(h.pageDelete).not.toHaveBeenCalled();
    expect(h.pageDeploy).not.toHaveBeenCalled();
  });
  it("allows cleanup even when new spending is blocked", async () => {
    h.spend.mockRejectedValue(new Error("out of credits"));
    const proxy = createTenantCloudAdmin("org-one", "ns-own");
    await proxy.disablePage!("own-page");
    await proxy.deletePage!("own-page");
    expect(h.pageDelete).toHaveBeenCalledWith("own-page");
    expect(h.spend).not.toHaveBeenCalled();
  });
  it("validates both hostname and every route target before an admin mutation", async () => {
    const proxy = createTenantCloudAdmin("org-one", "ns-own");
    const routes = [{ match: { path: "/" }, action: { kind: "proxy" as const, workspace: "ws-other", port: 8080 } }];
    await expect(proxy.setRoutes!("own.opsh.io", { routes })).rejects.toMatchObject({ statusCode: 404 });
    await expect(proxy.setRoutes!("other.opsh.io", { routes: [] })).rejects.toMatchObject({ statusCode: 404 });
    expect(h.setRoutes).not.toHaveBeenCalled();
    await proxy.setRoutes!("own.opsh.io", { routes: [{ ...routes[0]!, action: { kind: "proxy", workspace: "ws-own", port: 8080 } }] });
    expect(h.setRoutes).toHaveBeenCalledOnce();
  });
  it("does not use reseller authority for unverified external proxy origins", async () => {
    const proxy = createTenantCloudAdmin("org-one", "ns-own");
    await expect(proxy.setRoutes!("own.opsh.io", { routes: [{ match: { path: "/" }, action: { kind: "proxy", origin: "https://other-customer.example" } }] }))
      .rejects.toMatchObject({ code: "CLOUD_ROUTE_TARGET_INVALID" });
    expect(h.setRoutes).not.toHaveBeenCalled();
  });
});
