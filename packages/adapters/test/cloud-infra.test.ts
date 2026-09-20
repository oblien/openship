import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudInfraProvider } from "../src/infra/cloud";

const baseRoute = { hostname: "app.opsh.io", namespace: "ns-a", owner_type: "workspace", owner_id: "ws-a", is_custom: false, target: "10.0.0.1:3000" };
function setup(route = baseRoute) {
  const registry = vi.fn(async () => ({ data: [route] }));
  const revoke = vi.fn(async () => ({}));
  const disconnect = vi.fn(async () => ({}));
  const getDomain = vi.fn(async () => ({ customDomain: "app.example.com", sslStatus: "active", sslExpiry: "2099-01-01T00:00:00Z" }));
  const ws = { publicAccess: { list: vi.fn(async () => [{ port: 3000, url: "https://app.opsh.io" }, { port: 4000, url: "https://other.opsh.io" }]), revoke }, domains: { get: getDomain, disconnect, renewSSL: vi.fn(async () => ({})) } };
  const workspace = vi.fn(() => ws);
  const pages = { disable: vi.fn(async () => ({})), disconnectDomain: vi.fn(async () => ({})), getDomain: vi.fn(async () => ({ domain: { domain: "app.example.com", ssl: { status: "pending", expiresAt: null } } })), renewSSL: vi.fn(async () => ({})) };
  const page = { slug: "site-a", namespace: "ns-a", domain: "opsh.io", url: "https://app.opsh.io", custom_domain: "app.example.com" };
  Object.assign(pages, { list: vi.fn(async () => ({ pages: [page] })), get: vi.fn(async () => ({ page })) });
  const setRoutes = vi.fn(async () => ({}));
  const client = { domain: { routes: registry }, workspace, pages, routes: { set: setRoutes } };
  return { infra: new CloudInfraProvider(client as never, { namespace: "ns-a" }), client, registry, revoke, disconnect, getDomain, ws, workspace, pages, setRoutes };
}
describe("Oblien routing and certificates", () => {
  it("revokes only the matching workspace port", async () => {
    const h = setup();
    await h.infra.removeRoute("app.opsh.io");
    expect(h.revoke).toHaveBeenCalledExactlyOnceWith(3000);
    expect(h.disconnect).not.toHaveBeenCalled();
  });
  it("recognizes public-access entries that return the full domain without a URL", async () => {
    const h = setup();
    h.ws.publicAccess.list.mockResolvedValue([{ port: 3000, domain: "app.opsh.io" }] as never);
    await h.infra.removeRoute("app.opsh.io");
    expect(h.revoke).toHaveBeenCalledExactlyOnceWith(3000);
  });
  it("does not report deletion when registry and port state disagree", async () => {
    const h = setup();
    h.ws.publicAccess.list.mockResolvedValue([]);
    await expect(h.infra.removeRoute("app.opsh.io")).rejects.toThrow("no matching exposed port");
  });
  it("uses the owning workspace for a custom domain and propagates provider failures", async () => {
    const h = setup({ ...baseRoute, hostname: "app.example.com", is_custom: true });
    h.disconnect.mockRejectedValue(new Error("provider unavailable"));
    await expect(h.infra.removeRoute("app.example.com")).rejects.toThrow("provider unavailable");
    expect(h.workspace).toHaveBeenCalledWith("ws-a");
  });
  it("does not mutate a route returned for another namespace", async () => {
    const h = setup({ ...baseRoute, namespace: "ns-b" });
    await h.infra.removeRoute("app.opsh.io");
    expect(h.workspace).not.toHaveBeenCalled();
    expect(h.revoke).not.toHaveBeenCalled();
  });
  it("disables a page's managed route and disconnects a page's custom domain", async () => {
    const h = setup({ ...baseRoute, owner_type: "page", owner_id: "220" });
    await h.infra.removeRoute("app.opsh.io");
    expect(h.pages.disable).toHaveBeenCalledWith("site-a");
    h.registry.mockResolvedValue({ data: [{ ...baseRoute, hostname: "app.example.com", owner_type: "page", owner_id: "220", is_custom: true }] });
    await h.infra.removeRoute("app.example.com");
    expect(h.pages.disconnectDomain).toHaveBeenCalledWith("site-a");
  });
  it("reports certificate status from the provider without inventing an expiry", async () => {
    const h = setup({ ...baseRoute, hostname: "app.example.com", is_custom: true });
    expect(await h.infra.verifyCert("app.example.com")).toMatchObject({ verified: true, expiresAt: "2099-01-01T00:00:00.000Z" });
    h.getDomain.mockResolvedValue({ customDomain: "app.example.com", sslStatus: "pending", sslExpiry: "" });
    expect(await h.infra.verifyCert("app.example.com")).toMatchObject({ verified: false, expiresAt: "", reason: "missing" });
  });
  it("requires customer scope before reading infrastructure", async () => {
    const h = setup();
    await expect(new CloudInfraProvider(h.client as never).removeRoute("app.opsh.io")).rejects.toThrow("organization-scoped");
    expect(h.registry).not.toHaveBeenCalled();
  });
});
