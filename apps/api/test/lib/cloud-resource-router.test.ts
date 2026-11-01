import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Type } from "@sinclair/typebox";

const h = vi.hoisted(() => ({ fetch: vi.fn(), linked: new Set<string>() }));
vi.mock("@repo/platform/engine/lib/cloud/transport", async original => ({
  ...await original<typeof import("@repo/platform/engine/lib/cloud/transport")>(),
  cloudFetchAsOrgOwner: h.fetch,
  resolveOrgCloudUserId: async (org: string) => h.linked.has(org) ? "linked-owner" : null,
}));
import { repos, seedOwner, seedServer, type SeededOwner } from "../modules/jobs/_harness";
import { handleApiError } from "../../src/middleware/error-handler";
import { secureRouter } from "../../src/lib/secure-router";
import { serviceRoutes } from "../../src/modules/services/service.routes";
import { serverResourceRoutes } from "../../src/modules/system/server-resource.routes";
import { domainRoutes } from "../../src/modules/domains/domain.routes";
import { analyticsRoutes } from "../../src/modules/analytics/analytics.routes";
import { shutdownRateLimit } from "../../src/lib/rate-limit";

const synthetic = secureRouter(new Hono(), { module: "resource-router-test", basePath: "/api/system" });
synthetic.get("/clusters/:id/authority", { tag: "server:read", authorizationHandledByOperation: true }, c => {
  c.set("operationContextApplied", true); return c.json({ localCluster: true });
});
synthetic.patch("/servers/:id/validated", { tag: "server:write", body: Type.Object({ name: Type.String() }, { additionalProperties: false }) }, c => c.json({ local: true }));
synthetic.post("/servers/:id/payload", { tag: "server:write" }, c => c.json({ local: true }));
const app = new Hono().onError(handleApiError)
  .route("/api/system", serverResourceRoutes)
  .route("/api/domains", domainRoutes)
  .route("/api/analytics", analyticsRoutes)
  .route("/api/system", synthetic.hono)
  .route("/api/projects/:id/services", serviceRoutes);
let owner: SeededOwner;
const headers = () => ({ ...owner.auth, "X-Organization-Id": owner.orgId, "content-type": "application/json" });
const request = (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(async () => {
  vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory");
  h.fetch.mockReset(); h.linked.clear();
  owner = await seedOwner({ bound: false }); h.linked.add(owner.orgId);
  h.fetch.mockImplementation(async () => Response.json({ forwarded: true }));
});
afterAll(async () => { await shutdownRateLimit(); vi.unstubAllEnvs(); });

describe("shared Cloud resource gateway", () => {
  it.each([
    ["/api/system/servers/cloud-server", "GET"],
    ["/api/system/servers/cloud-server/network-settings", "GET"],
    ["/api/system/servers/cloud-server/managed/outbound", "GET"],
    ["/api/system/servers/cloud-server/managed/outbound/options", "GET"],
    ["/api/system/servers/cloud-server/usage", "GET"],
    ["/api/analytics/server/cloud-server?domain=api.example.test", "GET"],
    ["/api/projects/cloud-project/services/cloud-service/restart", "POST"],
    ["/api/projects/cloud-project/services/cloud-service", "GET"],
    ["/api/projects/cloud-project/services", "GET"],
  ])("routes %s through Cloud after local account authorization", async (path, method) => {
    const response = await request(path, method);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ forwarded: true });
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.fetch.mock.calls[0].slice(0, 2)).toEqual([owner.orgId, path]);
  });

  it("forwards nested collection mutations as well as reads", async () => {
    const response = await request("/api/projects/cloud-project/services", "POST", { name: "web", image: "nginx:alpine" });
    expect(response.status).toBe(200);
    expect(h.fetch).toHaveBeenCalledOnce();
  });
  it("routes an explicit outbound change through the owning Cloud API", async () => {
    const input = { mode: "managed", ip: "1.1.1.1", expectedRevision: "a".repeat(64), confirm: true };
    const response = await request("/api/system/servers/cloud-server/managed/outbound", "PATCH", input);
    expect(response.status).toBe(200);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.fetch.mock.calls[0].slice(0, 2)).toEqual([owner.orgId, "/api/system/servers/cloud-server/managed/outbound"]);
    expect(JSON.parse(h.fetch.mock.calls[0][2].body)).toEqual(input);
  });

  it("previews DNS on a discovered Cloud server without creating an execution link", async () => {
    const body = { hostname: "api.example.test", includeWww: true, serverId: "cloud-server" };
    const response = await request("/api/domains/preview", "POST", body);
    expect(response.status).toBe(200);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(h.fetch.mock.calls[0][2].body)).toEqual(body);
    expect(await repos.cloudWorkspace.listByOrganization(owner.orgId)).toEqual([]);
  });

  it("does not let a DNS preview use another tenant's local server", async () => {
    const foreign = await seedOwner();
    const serverId = await seedServer(foreign.orgId);
    const response = await request("/api/domains/preview", "POST", { hostname: "api.example.test", serverId });
    expect(response.status).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("lets Cloud validate a remote parent/child mismatch without trying to read the local child", async () => {
    h.fetch.mockImplementationOnce(async () => Response.json({ error: "Service not found" }, { status: 404 }));
    expect((await request("/api/projects/cloud-project/services/wrong-service/restart", "POST")).status).toBe(404);
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("keeps a local parent's service ownership check before any forwarding", async () => {
    const group = await repos.projectGroup.create({ organizationId: owner.orgId, name: "Local", slug: "local" });
    const project = await repos.project.create({ organizationId: owner.orgId, groupId: group.id, name: "Local", slug: "local" });
    expect((await request(`/api/projects/${project.id}/services/cloud-service/restart`, "POST")).status).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("keeps local server requests local and refuses another tenant's local server", async () => {
    const id = await seedServer(owner.orgId);
    expect((await request(`/api/system/servers/${id}/validated`, "PATCH", { name: "New name" })).status).toBe(200);
    const other = await seedOwner();
    const foreign = await seedServer(other.orgId);
    expect((await request(`/api/system/servers/${foreign}/validated`, "PATCH", { name: "Other" })).status).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("does not infer a server identity from a cluster URL", async () => {
    const response = await request("/api/system/clusters/cluster-id/authority");
    expect(await response.json()).toEqual({ localCluster: true });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("validates writes before forwarding and preserves upstream error status", async () => {
    expect((await request("/api/system/servers/cloud-server/validated", "PATCH", { name: 42 })).status).toBe(400);
    expect(h.fetch).not.toHaveBeenCalled();
    h.fetch.mockImplementationOnce(async () => Response.json({ code: "SERVER_BUSY" }, { status: 409 }));
    expect((await request("/api/system/servers/cloud-server/validated", "PATCH", { name: "Valid" })).status).toBe(409);
  });

  it("preserves binary request bytes and their content type", async () => {
    const payload = new Uint8Array([0, 255, 128, 42, 10]);
    const response = await app.request("/api/system/servers/cloud-server/payload", {
      method: "POST", headers: { ...headers(), "content-type": "application/octet-stream" }, body: payload,
    });
    expect(response.status).toBe(200);
    const forwarded = h.fetch.mock.calls[0][2] as RequestInit;
    expect(new Headers(forwarded.headers).get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(forwarded.body as ArrayBuffer)).toEqual(payload);
  });

  it("does not forward an unauthenticated, unlinked, or locally scoped credential", async () => {
    expect((await app.request("/api/system/servers/cloud-server")).status).toBe(401);
    h.linked.clear();
    expect((await request("/api/system/servers/cloud-server")).status).toBe(404);
    owner = await seedOwner(); h.linked.add(owner.orgId);
    expect((await request("/api/system/servers/cloud-server")).status).toBe(409);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("streams Cloud logs through the existing endpoint", async () => {
    h.fetch.mockImplementationOnce(async () => new Response("event: log\ndata: hello\n\n", { headers: { "content-type": "text/event-stream" } }));
    const response = await request("/api/projects/cloud-project/services/cloud-service/logs/stream");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("event: log\ndata: hello\n\n");
  });
});
