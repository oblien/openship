import { beforeEach, describe, expect, it } from "vitest";
import { managedRoutingFixture } from "../../test/managed-routing-fixture";
let h: ReturnType<typeof managedRoutingFixture>;
beforeEach(() => { h = managedRoutingFixture(); });
const route = { domain: "app.opsh.io", targetUrl: "http://127.0.0.1:3000", tls: true };

describe("project routes on a managed server", () => {
  it("updates one project-owned Page repeatedly without a new workspace", async () => {
    await h.infra.registerRoute(route);
    await h.infra.registerRoute(route);
    expect(h.pages.create).toHaveBeenCalledOnce();
    expect(h.routes.set).toHaveBeenCalledTimes(2);
    expect(h.routes.set).toHaveBeenLastCalledWith(route.domain, { routes: [{ match: { path: "/", type: "prefix" }, action: { kind: "proxy", workspace: h.workspaceId, port: 3000 } }] });
    expect(h.workspace.network.update).toHaveBeenCalledWith({ ingress_ports: [443, 3000] });
  });
  it.each(["namespace", "source_workspace_id", "exported_path"])("refuses a changed %s before mutating the route", async field => {
    await h.infra.registerRoute(route);
    h.records.get("app")![field] = "another-owner";
    h.routes.set.mockClear(); h.pages.enable.mockClear();
    await expect(h.infra.registerRoute(route)).rejects.toThrow("not owned");
    expect(h.routes.set).not.toHaveBeenCalled();
    expect(h.pages.enable).not.toHaveBeenCalled();
  });
  it.each(["http://127.0.0.1:4000", "http://attacker.example:3000", "http://user:secret@127.0.0.1:3000", "ftp://127.0.0.1:3000"])("rejects an unowned upstream %s", async targetUrl => {
    await expect(h.infra.registerRoute({ ...route, targetUrl })).rejects.toThrow();
    expect(h.pages.create).not.toHaveBeenCalled();
    expect(h.routes.set).not.toHaveBeenCalled();
  });
  it("preserves provider failure and remains retryable", async () => {
    h.routes.set.mockRejectedValueOnce(new Error("edge unavailable"));
    await expect(h.infra.registerRoute(route)).rejects.toThrow("edge unavailable");
    await h.infra.registerRoute(route);
    expect(h.pages.create).toHaveBeenCalledOnce();
  });
  it("validates every composite backend, not only the root", async () => {
    await h.infra.registerRoute(route);
    h.routes.set.mockClear();
    await expect(h.infra.setDomainRoutes(route.domain, { routes: [{ match: { path: "/admin", type: "prefix" }, action: { kind: "proxy", workspace: "another-vm", port: 3000 } }] })).rejects.toThrow("does not belong");
    await expect(h.infra.setDomainRoutes(route.domain, { routes: [{ match: { path: "/admin", type: "prefix" }, action: { kind: "proxy", workspace: h.workspaceId, port: 4000 } }] })).rejects.toThrow("unowned");
    expect(h.routes.set).not.toHaveBeenCalled();
  });
  it("keeps unrelated ingress ports when adding an application", async () => {
    h.workspace.network.get.mockResolvedValue({ ingress_ports: [22, 443, 8080] });
    await h.infra.registerRoute(route);
    expect(h.workspace.network.update).toHaveBeenCalledWith({ ingress_ports: [22, 443, 8080, 3000] });
  });
});
