import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";

const h = vi.hoisted(() => ({ token: vi.fn(), namespace: vi.fn(), pages: vi.fn() }));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return { ...actual, env: { ...actual.env, CLOUD_MODE: true } };
});
vi.mock("@repo/platform/engine/lib/openship-cloud", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/openship-cloud")>()),
  issueNamespaceToken: h.token,
  ensureNamespace: h.namespace,
}));
vi.mock("@repo/platform/engine/lib/cloud-tenant-admin", () => ({
  createTenantCloudAdmin: () => ({ pages: { list: h.pages } }),
}));

import { db, repos, schema, seedOwner, installFakeRunner, type SeededOwner } from "./jobs/_harness";
import { eq } from "@repo/db";
import { cloudSaasRoutes } from "../../src/modules/cloud/cloud-saas.routes";
import { handleApiError } from "../../src/middleware/error-handler";
import { shutdownRateLimit } from "../../src/lib/rate-limit";

installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .use("*", async (c, next) => {
    c.set("clientIp", "192.0.2.81");
    await next();
  })
  .route("/api/cloud", cloudSaasRoutes);
let actor: SeededOwner;
let token: string;
let serverId: string;
let workspaceId: string;
let memberId: string;

beforeAll(() => vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory"));
afterAll(async () => {
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  vi.resetAllMocks();
  actor = await seedOwner();
  const workspace = await repos.cloudWorkspace.create({
    organizationId: actor.orgId,
    name: "Private server",
  });
  workspaceId = workspace.id;
  serverId = (await repos.server.findByWorkspace(workspaceId, actor.orgId))!.id;
  memberId = (await repos.member.find(actor.orgId, actor.userId))!.id;
  await db.update(schema.member).set({ role: "restricted" }).where(eq(schema.member.id, memberId));
  await db.insert(schema.resourceGrant).values({
    id: randomUUID(),
    organizationId: actor.orgId,
    userId: actor.userId,
    resourceType: "cloud",
    resourceId: "*",
    permissionsJson: '["admin"]',
  });
  token = `cloud-session-${randomUUID()}`;
  await db.insert(schema.session).values({
    id: randomUUID(),
    token,
    userId: actor.userId,
    activeOrganizationId: actor.orgId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  h.token.mockResolvedValue({
    token: "provider-secret",
    namespace: "ns-own",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  h.namespace.mockResolvedValue("ns-own");
  h.pages.mockResolvedValue({ pages: [] });
});

function post(path: string, body?: unknown) {
  return app.request(`/api/cloud/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Organization-Id": actor.orgId,
      "X-Openship-Scope": "fixed",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function grantServer(id = serverId, permission = "admin") {
  await db.insert(schema.resourceGrant).values({
    id: randomUUID(),
    organizationId: actor.orgId,
    userId: actor.userId,
    resourceType: "server",
    resourceId: id,
    permissionsJson: JSON.stringify([permission]),
  });
}

describe("Cloud relays cannot substitute Cloud feature access for host administration", () => {
  it.each([undefined, "read", "write"])(
    "denies raw provider tokens without server admin (%s)",
    async (permission) => {
      if (permission) await grantServer(serverId, permission);
      const response = await post("token");
      expect(response.status, await response.clone().text()).toBe(404);
      expect(h.token).not.toHaveBeenCalled();
    },
  );

  it("allows the authorized legacy single-server token flow and prevents caching its secret", async () => {
    await grantServer();
    const response = await post("token");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(h.token).toHaveBeenCalledWith(actor.orgId, workspaceId);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ data: { token: "provider-secret" } });
  });

  it.each(["owner", "admin", "member"])(
    "preserves existing full host access for the %s role",
    async (role) => {
      await db.update(schema.member).set({ role }).where(eq(schema.member.id, memberId));
      expect((await post("token")).status).toBe(200);
      expect(h.token).toHaveBeenCalledWith(actor.orgId, workspaceId);
    },
  );

  it("does not bootstrap a server or credentials for an empty organization without host authority", async () => {
    actor = await seedOwner();
    const membership = (await repos.member.find(actor.orgId, actor.userId))!;
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.id, membership.id));
    await db.insert(schema.resourceGrant).values({
      id: randomUUID(),
      organizationId: actor.orgId,
      userId: actor.userId,
      resourceType: "cloud",
      resourceId: "*",
      permissionsJson: '["admin"]',
    });
    await db
      .update(schema.session)
      .set({ userId: actor.userId, activeOrganizationId: actor.orgId })
      .where(eq(schema.session.token, token));
    expect((await post("token")).status).toBe(404);
    expect(h.token).not.toHaveBeenCalled();
    expect(await repos.cloudWorkspace.listByOrganization(actor.orgId)).toEqual([]);
  });

  it("cannot bypass selected-server authorization by omitting the selector", async () => {
    for (const path of ["resource-proxy", `resource-proxy?serverId=${serverId}`]) {
      const response = await post(path, { operation: "list" });
      expect(response.status, await response.clone().text()).toBe(404);
    }
    expect(h.namespace).not.toHaveBeenCalled();
    expect(h.pages).not.toHaveBeenCalled();
  });

  it("allows the same authorized server with an explicit or implicit selector", async () => {
    await grantServer();
    for (const path of ["resource-proxy", `resource-proxy?serverId=${serverId}`]) {
      const response = await post(path, { operation: "list" });
      expect(response.status, await response.clone().text()).toBe(200);
    }
    expect(h.namespace).toHaveBeenCalledWith(actor.orgId, workspaceId);
    expect(h.pages).toHaveBeenCalledTimes(2);
  });

  it("does not accept a forged grant or selector for a different tenant's server", async () => {
    const victim = await seedOwner();
    const foreignWorkspace = await repos.cloudWorkspace.create({
      organizationId: victim.orgId,
      name: "Victim server",
    });
    const foreignServer = (await repos.server.findByWorkspace(foreignWorkspace.id, victim.orgId))!;
    await grantServer(foreignServer.id);
    const response = await post(`resource-proxy?serverId=${foreignServer.id}`, {
      operation: "list",
    });
    expect(response.status).toBe(404);
    expect(h.namespace).not.toHaveBeenCalled();
    expect(h.pages).not.toHaveBeenCalled();
  });

  it("rechecks revoked server administration before issuing another credential", async () => {
    await grantServer();
    expect((await post("token")).status).toBe(200);
    await db.delete(schema.resourceGrant).where(eq(schema.resourceGrant.resourceId, serverId));
    h.token.mockClear();
    expect((await post("token")).status).toBe(404);
    expect(h.token).not.toHaveBeenCalled();
  });

  it("requires a selector rather than guessing between independent servers", async () => {
    await grantServer();
    await repos.cloudWorkspace.create({ organizationId: actor.orgId, name: "Second server" });
    const implicit = await post("token");
    expect(implicit.status, await implicit.clone().text()).toBe(400);
    expect(await implicit.json()).toMatchObject({ code: "CLOUD_WORKSPACE_REQUIRED" });
    expect(h.token).not.toHaveBeenCalled();
    expect((await post(`resource-proxy?serverId=${serverId}`, { operation: "list" })).status).toBe(
      200,
    );
  });

  it.each([
    ["preflight", {}],
    ["pages", { workspace_id: "vm-own", path: "/private", name: "export", slug: "export" }],
    ["pages/enable", { slug: "own-page" }],
    ["pages/disable", { slug: "own-page" }],
    ["pages/delete", { slug: "own-page" }],
  ])("keeps the legacy %s relay behind host permissions", async (path, body) => {
    const response = await post(path, body);
    expect(response.status, await response.clone().text()).toBe(404);
    expect(h.namespace).not.toHaveBeenCalled();
  });
});
