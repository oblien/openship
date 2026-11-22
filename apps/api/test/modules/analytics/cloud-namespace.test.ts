import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";
import { proxyCloudAnalytics } from "@repo/platform/engine/modules/cloud/cloud-analytics.service";

const h = vi.hoisted(() => ({
  domain: vi.fn(), project: vi.fn(), owner: vi.fn(), selection: vi.fn(), server: vi.fn(), authorize: vi.fn(), mint: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { domain: { findByHostname: h.domain }, project: { findByIdInOrganization: h.project } } }));
vi.mock("@repo/platform/engine/lib/cloud-workspace-scope", () => ({ cloudBillingOwner: h.owner, workspaceForServer: h.selection, requireWorkspaceServer: h.server }));
vi.mock("@repo/platform/engine/lib/authorization", () => ({ authorization: { authorize: h.authorize } }));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({ getOblienClient: () => ({ tokens: { create: h.mint } }) }));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { OBLIEN_API_URL: "https://provider.example/v2" } }));

const ctx = { organizationId: "org-one" } as ExecutionContext;
const workspace = { id: "workspace-one", namespace: "tenant-one" };
const input = { operation: "timeseries" as const, domain: "app.example.com" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", h.fetch);
  h.selection.mockResolvedValue({ workspace, server: { id: "server-one" } });
  h.server.mockResolvedValue({ id: "server-one" });
  h.domain.mockResolvedValue({ projectId: "project-one" });
  h.project.mockResolvedValue({ workspaceId: "workspace-one" });
  h.owner.mockResolvedValue({ workspace });
  h.mint.mockResolvedValue({ success: true, scope: "namespace", token: "tenant-token" });
  h.fetch.mockResolvedValue(Response.json({ success: true, data: [] }));
});
afterEach(() => vi.unstubAllGlobals());

describe("Cloud traffic relay", () => {
  it("uses a namespace token and forwards only supported aggregate query parameters", async () => {
    await proxyCloudAnalytics(ctx, { ...input, params: { interval: "hour", ns: "other", operation: "requests" } });
    expect(h.project).toHaveBeenCalledWith("project-one", "org-one");
    expect(h.owner).toHaveBeenCalledExactlyOnceWith("org-one", "workspace-one");
    expect(h.authorize).toHaveBeenCalledExactlyOnceWith(ctx, { resourceType: "server", resourceId: "server-one", action: "read" });
    expect(h.mint).toHaveBeenCalledExactlyOnceWith({ scope: "namespace", namespace: "tenant-one", ttl: 60 });
    expect(h.fetch).toHaveBeenCalledOnce();
    const [url, init] = h.fetch.mock.calls[0];
    expect(String(url)).toBe("https://provider.example/v2/analytics/app.example.com/timeseries?interval=hour");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tenant-token");
  });

  it("can read a desktop-only hostname for the selected server", async () => {
    h.domain.mockResolvedValue(null);
    await proxyCloudAnalytics(ctx, { ...input, serverId: "server-one" });
    expect(h.selection).toHaveBeenCalledExactlyOnceWith("org-one", "server-one");
    expect(h.authorize).toHaveBeenCalledExactlyOnceWith(ctx, { resourceType: "server", resourceId: "server-one", action: "read" });
  });

  it("denies a foreign project or a conflicting server before requesting a token", async () => {
    h.selection.mockResolvedValue({ workspace: { ...workspace, id: "workspace-two" }, server: { id: "server-two" } });
    await expect(proxyCloudAnalytics(ctx, { ...input, serverId: "server-two" })).rejects.toMatchObject({ status: 403 });
    h.project.mockResolvedValue(null);
    await expect(proxyCloudAnalytics(ctx, input)).rejects.toMatchObject({ status: 403 });
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "server-one"])("requires server read access before issuing credentials (serverId=%s)", async (serverId) => {
    h.authorize.mockRejectedValue(new Error("Permission denied"));
    await expect(proxyCloudAnalytics(ctx, { ...input, serverId })).rejects.toThrow("Permission denied");
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("does not create a missing namespace or use owner credentials as a fallback", async () => {
    h.owner.mockResolvedValue({ workspace: { ...workspace, namespace: null } });
    await expect(proxyCloudAnalytics(ctx, input)).rejects.toMatchObject({ code: "CLOUD_NAMESPACE_NOT_FOUND" });
    expect(h.mint).not.toHaveBeenCalled();
    h.owner.mockResolvedValue({ workspace });
    h.mint.mockResolvedValue({ success: true, scope: "admin", token: "wrong-scope" });
    await expect(proxyCloudAnalytics(ctx, input)).rejects.toMatchObject({ code: "ANALYTICS_UPSTREAM_UNAVAILABLE" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
