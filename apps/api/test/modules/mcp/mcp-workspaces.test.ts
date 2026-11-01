import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq, and } from "@repo/db";
import type { WorkspaceList } from "@repo/contracts";

// Re-enter the real routers without app.ts's schedulers or server startup.
const forwarding = vi.hoisted(() => ({ fetch: vi.fn<(request: Request) => Promise<Response> | Response>() }));
vi.mock("../../../src/app", () => ({ app: forwarding }));
// Use the bundled catalog so installation tests cannot refresh it over HTTP.
vi.mock("@repo/platform/engine/modules/apps/catalog-source", async (importOriginal) => ({
  ...await importOriginal<typeof import("@repo/platform/engine/modules/apps/catalog-source")>(),
  getTemplateForOrg: async (_organizationId: string, id: string) => (await import("@repo/core")).getAppTemplate(id),
}));

import { seedOwner, db, repos, schema, type SeededOwner } from "../jobs/_harness";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { OpenshipClient } from "@repo/sdk/client";
import { createShip } from "@repo/sdk/native";
import { permissionsRoutes } from "../../../src/modules/permissions/permissions.routes";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { appRoutes } from "../../../src/modules/apps/app.routes";
import { serviceRoutes } from "../../../src/modules/services/service.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { mcpRoutes } from "../../../src/modules/mcp/mcp.routes";
import { getMcpTools, resetMcpToolCache } from "../../../src/modules/mcp/mcp-tools";
import { getPrompt } from "../../../src/modules/mcp/mcp-prompts";
import { handleApiError } from "../../../src/middleware/error-handler";
import { clientIpMiddleware } from "../../../src/middleware/client-ip";
import { shutdownRateLimit } from "../../../src/lib/rate-limit";

const app = new Hono().onError(handleApiError)
  .use("*", clientIpMiddleware)
  .route("/api/permissions", permissionsRoutes)
  .route("/api/projects", projectRoutes)
  .route("/api/projects/:id/services", serviceRoutes)
  .route("/api/apps", appRoutes)
  .route("/api/health", healthRoutes)
  .route("/api/mcp", mcpRoutes);

beforeAll(() => {
  vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory");
  forwarding.fetch.mockImplementation(request => app.fetch(request));
  resetMcpToolCache();
});
afterEach(() => forwarding.fetch.mockClear());
afterAll(async () => {
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});

async function rpc(owner: SeededOwner, method: string, params?: Record<string, unknown>) {
  return app.request("/api/mcp", {
    method: "POST", headers: { ...owner.auth, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
async function call<T>(owner: SeededOwner, name: string, args: Record<string, unknown> = {}) {
  const response = await rpc(owner, "tools/call", { name, arguments: args });
  expect(response.status, await response.clone().text()).toBe(200);
  const envelope = await response.json() as { result: { isError: boolean; content: { text: string }[] } };
  expect(envelope.result).toBeDefined();
  return { isError: envelope.result.isError, data: JSON.parse(envelope.result.content[0].text) as T };
}
async function discover(owner: SeededOwner, args: Record<string, unknown> = {}) {
  const result = await call<{ data: WorkspaceList }>(owner, "get_permissions_workspaces", args);
  expect(result.isError).toBe(false);
  return result.data.data;
}
async function secondWorkspace(owner: SeededOwner, role = "owner") {
  const target = await seedOwner();
  await db.insert(schema.member).values({
    id: `mem_${owner.userId}_${target.orgId}`, userId: owner.userId,
    organizationId: target.orgId, role,
  });
  return target;
}
async function limitedCredential(owner: SeededOwner, scoped: boolean, bound = true) {
  const token = mintPatToken();
  await repos.personalAccessToken.create({
    userId: owner.userId, organizationId: bound ? owner.orgId : null,
    name: "workspace-discovery", tokenPrefix: token.tokenPrefix, tokenHash: token.tokenHash,
    readOnly: true, scoped, expiresAt: null,
  });
  return { ...owner, token: token.token, auth: { Authorization: `Bearer ${token.token}` } };
}

describe("MCP workspace discovery", () => {
  it("lists current memberships including empty workspaces, without leaking strangers", async () => {
    const owner = await seedOwner({ bound: false });
    const target = await secondWorkspace(owner);
    const stranger = await seedOwner();
    const found = await discover(owner);
    expect(found).toMatchObject({ currentOrganizationId: owner.orgId, boundOrganizationId: null, canSwitchOrganization: true, readOnly: false });
    expect(found.workspaces.map(workspace => workspace.organizationId).sort()).toEqual([owner.orgId, target.orgId].sort());
    expect(found.workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ organizationId: target.orgId, name: "Test Org", role: "owner", isTeam: false, slug: expect.any(String) }),
    ]));
    expect(JSON.stringify(found)).not.toContain(stranger.orgId);
  });

  it.each([false, true])("exposes discovery to read-only credentials (scoped=%s) only within their binding", async scoped => {
    const owner = await seedOwner();
    const target = await secondWorkspace(owner);
    const caller = await limitedCredential(owner, scoped);
    const listed = await (await rpc(caller, "tools/list")).json() as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map(tool => tool.name)).toContain("get_permissions_workspaces");
    expect(listed.result.tools.map(tool => tool.name)).not.toContain("post_apps");
    const found = await discover(caller);
    expect(found).toMatchObject({ boundOrganizationId: owner.orgId, canSwitchOrganization: false, readOnly: true });
    expect(found.workspaces).toHaveLength(1);
    expect(found.workspaces[0]).toMatchObject({ organizationId: owner.orgId, role: scoped ? "restricted" : "owner" });
    expect(JSON.stringify(found)).not.toContain(target.orgId);
    const forbidden = await call<{ code: string }>(caller, "get_permissions_workspaces", { organizationId: target.orgId });
    expect(forbidden).toMatchObject({ isError: true, data: { code: "TOKEN_ORG_SCOPE" } });
  });

  it("does not silently default a stale bound credential to another membership", async () => {
    const owner = await seedOwner();
    await secondWorkspace(owner);
    await db.delete(schema.member).where(and(eq(schema.member.userId, owner.userId), eq(schema.member.organizationId, owner.orgId)));
    expect((await rpc(owner, "initialize")).status).toBe(401);
  });

  it("rejects a scoped credential with no organization binding", async () => {
    const owner = await seedOwner();
    const caller = await limitedCredential(owner, true, false);
    expect((await rpc(caller, "tools/list")).status).toBe(401);
  });

  it("advertises tools available in a nondefault workspace for an unbound credential", async () => {
    const owner = await seedOwner({ bound: false });
    await secondWorkspace(owner);
    await db.update(schema.member).set({ role: "restricted" }).where(and(eq(schema.member.userId, owner.userId), eq(schema.member.organizationId, owner.orgId)));
    const listed = await (await rpc(owner, "tools/list")).json() as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map(tool => tool.name)).toContain("post_apps");
    const denied = await call(owner, "post_projects", { organizationId: owner.orgId, body: { name: "forbidden" } });
    expect(denied.isError).toBe(true);
  });

  it("shares the discovery contract with SDKs and respects fixed native scopes", async () => {
    const owner = await seedOwner({ bound: false });
    const target = await secondWorkspace(owner);
    const http = new OpenshipClient({ baseUrl: "http://openship.test", token: owner.token, fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
    expect((await http.permissions.listWorkspaces()).workspaces).toHaveLength(2);
    const remote = await http.scope(target.orgId).permissions.listWorkspaces();
    const user = (await repos.user.findById(owner.userId))!;
    const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({ user, sessionId: "workspace-test", credential: { organizationId: null, readOnly: false } }) } });
    const native = await (await ship.scope({ identity: "verified", organizationId: target.orgId })).permissions.listWorkspaces();
    expect(remote).toEqual(native);
    expect(remote.currentOrganizationId).toBe(target.orgId);
    expect(remote.workspaces.map(workspace => workspace.organizationId)).toEqual([target.orgId]);
  });
});

describe("MCP destination selection", () => {
  it("advertises organizationId on the actual app, Compose and service tools", () => {
    for (const name of ["post_apps", "post_projects", "post_projects_ensure", "post_projects_folder_session", "post_projects_by_id_services_sync"]) {
      const tool = getMcpTools().find(tool => tool.name === name);
      expect(tool, name).toBeDefined();
      expect((tool!.inputSchema.properties as Record<string, unknown>).organizationId).toMatchObject({ type: "string", minLength: 1 });
    }
    const tool = getMcpTools().find(tool => tool.name === "post_apps")!;
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it("creates a Compose project and its services in the explicitly selected workspace", async () => {
    const owner = await seedOwner({ bound: false });
    const target = await secondWorkspace(owner);
    const result = await call<{ project_id: string }>(owner, "post_projects_ensure", {
      organizationId: target.orgId,
      body: { name: "Workspace Compose", gitProvider: "upload", framework: "docker-compose", projectType: "services", publicEndpoints: [], services: [
        { name: "web", image: "nginx:alpine", ports: ["80"] },
        { name: "db", image: "postgres:16", volumes: ["pgdata:/var/lib/postgresql/data"] },
      ] },
    });
    expect(result.isError, JSON.stringify(result.data)).toBe(false);
    expect((await repos.project.findById(result.data.project_id))?.organizationId).toBe(target.orgId);
    expect((await repos.service.listByProject(result.data.project_id)).map(service => service.name).sort()).toEqual(["db", "web"]);
    expect((await repos.project.listByOrganization(owner.orgId)).total).toBe(0);
    expect(forwarding.fetch.mock.calls[0][0].headers.get("X-Openship-Scope")).toBe("fixed");
    // A selection applies only to the call, not the account's future default.
    expect((await discover(owner)).currentOrganizationId).toBe(owner.orgId);
  });

  it("installs a catalog app in the selected workspace, retaining its service data", async () => {
    const owner = await seedOwner({ bound: false });
    const target = await secondWorkspace(owner);
    const result = await call<{ data: { projectId: string } }>(owner, "post_apps", {
      organizationId: target.orgId, body: { templateId: "redis", name: "Workspace Redis" },
    });
    expect(result.isError, JSON.stringify(result.data)).toBe(false);
    expect((await repos.project.findById(result.data.data.projectId))?.organizationId).toBe(target.orgId);
    expect((await repos.service.listByProject(result.data.data.projectId)).length).toBeGreaterThan(0);
    expect((await repos.project.listByOrganization(owner.orgId)).total).toBe(0);
  });

  it("rejects a workspace outside membership without creating anything in the default", async () => {
    const owner = await seedOwner({ bound: false });
    const stranger = await seedOwner();
    const denied = await call(owner, "post_projects_ensure", { organizationId: stranger.orgId, body: { name: "Never create" } });
    expect(denied.isError).toBe(true);
    expect((await repos.project.listByOrganization(owner.orgId)).total).toBe(0);
    expect((await repos.project.listByOrganization(stranger.orgId)).total).toBe(0);
  });

  it("cannot use organizationId to move or mutate a project belonging to another workspace", async () => {
    const owner = await seedOwner({ bound: false });
    const target = await secondWorkspace(owner);
    const group = await repos.projectGroup.create({ organizationId: owner.orgId, name: "Original", slug: "original" });
    const project = await repos.project.create({ organizationId: owner.orgId, groupId: group.id, name: "Original", slug: "original" });
    const denied = await call(owner, "patch_projects_by_id", { id: project.id, organizationId: target.orgId, body: { name: "Moved" } });
    expect(denied.isError).toBe(true);
    expect(await repos.project.findById(project.id)).toMatchObject({ name: "Original", organizationId: owner.orgId });
  });

  it.each(["", " ", " org_target ", "org\nother", "org_target\n", "org_target\r\n", null, 42, {}, "x".repeat(513)])("rejects malformed destination %j before dispatch", async organizationId => {
    const owner = await seedOwner({ bound: false });
    const denied = await call(owner, "post_projects", { organizationId, body: { name: "Never create" } });
    expect(denied).toMatchObject({ isError: true, data: { code: "INVALID_ORGANIZATION_ID" } });
    expect(forwarding.fetch).not.toHaveBeenCalled();
    expect((await repos.project.listByOrganization(owner.orgId)).total).toBe(0);
  });

  it("rejects malformed argument objects", async () => {
    const owner = await seedOwner();
    for (const args of [null, [], "org_target"]) {
      const result = await (await rpc(owner, "tools/call", { name: "post_projects", arguments: args })).json();
      expect(result).toMatchObject({ error: { code: -32602 } });
    }
    expect(forwarding.fetch).not.toHaveBeenCalled();
  });

  it("gives workspace-first instructions during initialization and in every creation flow", async () => {
    const owner = await seedOwner();
    const initialized = await (await rpc(owner, "initialize")).json() as { result: { instructions: string } };
    expect(initialized.result.instructions).toContain(owner.orgId);
    expect(initialized.result.instructions).toContain("get_permissions_workspaces");
    for (const name of ["deploy-from-git", "deploy-a-folder", "install-catalog-app"]) {
      const text = (getPrompt(name, {})!.messages[0] as { content: { text: string } }).content.text;
      expect(text.indexOf("get_permissions_workspaces")).toBeLessThan(text.indexOf("1."));
      expect(text).toContain("TOP-LEVEL");
      expect(text).toContain("organizationId");
      expect(text).toContain("ask which one");
      expect(text).not.toContain("POST /api/projects");
    }
  });
});
