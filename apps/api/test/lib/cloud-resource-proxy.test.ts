import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  request: vi.fn(), pageGet: vi.fn(), pageCreate: vi.fn(), pageDeploy: vi.fn(), pageDelete: vi.fn(),
  workspaceGet: vi.fn(), routes: vi.fn(), setRoutes: vi.fn(), spend: vi.fn(), pageList: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ cloudClient: () => ({ request: h.request }) }));
vi.mock("../../src/lib/request-context", () => ({ getRequestContext: () => ({ organizationId: "org-a" }) }));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({ ensureNamespace: async () => "ns-a" }));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({ getOblienClient: () => ({
  workspaces: { get: h.workspaceGet },
  pages: { list: h.pageList, get: h.pageGet, create: h.pageCreate, deploy: h.pageDeploy, delete: h.pageDelete },
  domain: { routes: h.routes }, routes: { set: h.setRoutes },
}) }));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({ assertCloudCanSpend: h.spend }));

import { createRemoteCloudAdmin } from "@repo/platform/engine/lib/cloud/admin-proxy";
import { cloudResourceProxy, cloudRouteRegistry } from "../../src/modules/cloud/cloud-resource.controller";
import { handleApiError } from "../../src/middleware/error-handler";

const app = new Hono().onError(handleApiError)
  .post("/api/cloud/resource-proxy", cloudResourceProxy)
  .get("/api/cloud/route-registry", cloudRouteRegistry);
beforeEach(() => {
  vi.resetAllMocks();
  h.request.mockImplementation((path, init) => app.request(`http://cloud.test${path}`, init));
  h.workspaceGet.mockImplementation(async (id) => ({ id, namespace: id === "ws-a" ? "ns-a" : "ns-b" }));
  h.pageGet.mockImplementation(async (slug) => ({ success: true, page: { slug, namespace: slug === "site-a" ? "ns-a" : "ns-b" } }));
  h.pageCreate.mockResolvedValue({ success: true, page: { slug: "site-a", namespace: "ns-a" } });
  h.pageDeploy.mockResolvedValue({ success: true, page: { slug: "site-a", namespace: "ns-a" } });
  h.routes.mockResolvedValue({ success: true, data: [{ hostname: "a.opsh.io", namespace: "ns-a" }, { hostname: "b.opsh.io", namespace: "ns-b" }] });
});

describe("desktop-to-SaaS Cloud resource delegation", () => {
  it("returns only the authenticated organization's Page inventory", async () => {
    h.pageList.mockResolvedValue({ success: true, pages: [{ slug: "site-a", namespace: "ns-a" }, { slug: "site-b", namespace: "ns-b" }] });
    expect(await createRemoteCloudAdmin("org-a").pages!.list()).toEqual({ success: true, pages: [{ slug: "site-a", namespace: "ns-a" }] });
    const response = await app.request("/api/cloud/resource-proxy", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "list", namespace: "ns-b" }) });
    expect(response.status).toBe(400);
  });
  it("round-trips page reads and redeploys through the SaaS ownership checks", async () => {
    const proxy = createRemoteCloudAdmin("org-a");
    expect(await proxy.pages!.get("site-a")).toMatchObject({ page: { namespace: "ns-a" } });
    await proxy.pages!.deploy("site-a", { workspace_id: "ws-a", path: "/app/dist" });
    expect(h.pageDeploy).toHaveBeenCalledWith("site-a", { workspace_id: "ws-a", path: "/app/dist" });
    expect(h.spend).toHaveBeenCalledWith("org-a");
  });
  it("ignores the client's namespace and pins a create to its server identity", async () => {
    await createRemoteCloudAdmin("org-a").pages!.create({ workspace_id: "ws-a", path: "/app/dist", name: "Site", slug: "site-a", namespace: "ns-b" });
    expect(h.pageCreate).toHaveBeenCalledWith(expect.objectContaining({ namespace: "ns-a" }));
  });
  it("refuses both foreign page reads and foreign source exports", async () => {
    const pages = createRemoteCloudAdmin("org-a").pages!;
    await expect(pages.get("site-b")).rejects.toMatchObject({ status: 404 });
    await expect(pages.create({ workspace_id: "ws-b", path: "/app/dist", name: "Site", slug: "site-a" })).rejects.toMatchObject({ status: 404 });
    expect(h.pageCreate).not.toHaveBeenCalled();
  });
  it("preserves provider 404 so the runtime can create a missing page", async () => {
    h.pageGet.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
    await expect(createRemoteCloudAdmin("org-a").pages!.get("missing")).rejects.toMatchObject({ status: 404 });
  });
  it("filters the route registry and refuses arbitrary admin operations", async () => {
    expect(await createRemoteCloudAdmin("org-a").domainRoutes!()).toMatchObject({ data: [{ hostname: "a.opsh.io" }] });
    const response = await app.request("/api/cloud/resource-proxy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "constructor", slug: "site-a" }) });
    expect(response.status).toBe(400);
  });
  it("rejects external origins at the RPC boundary", async () => {
    await expect(createRemoteCloudAdmin("org-a").setRoutes!("a.opsh.io", {
      routes: [{ match: { path: "/" }, action: { kind: "proxy", origin: "https://other.example" } }],
    })).rejects.toMatchObject({ status: 400 });
    expect(h.setRoutes).not.toHaveBeenCalled();
  });
});
