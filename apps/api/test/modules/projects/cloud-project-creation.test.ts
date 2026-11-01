import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { isProject } from "@repo/contracts";
import type { ExecutionContext } from "@repo/platform";

const h = vi.hoisted(() => ({
  linked: new Set<string>(),
  identity: {
    apiUrl: "https://api.openship.test",
    userId: "cloud-owner",
    organizationId: "cloud-org",
  },
  fetch: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/cloud/transport", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/cloud/transport")>()),
  resolveOrgCloudUserId: async (org: string) => (h.linked.has(org) ? "linked-owner" : null),
  readCloudSession: async () => ({ ...h.identity, token: "upstream-session" }),
  cloudFetchAsOrgOwner: h.fetch,
}));

import { repos, seedOwner, seedServer, type SeededOwner } from "../jobs/_harness";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { appRoutes } from "../../../src/modules/apps/app.routes";
import { serviceRoutes } from "../../../src/modules/services/service.routes";
import { actionRoutes } from "../../../src/modules/actions/action.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { shutdownRateLimit } from "../../../src/lib/rate-limit";
import { maybeCloudProjectRequest } from "@repo/platform/engine/lib/cloud/project-creation";
import { projectDependencies } from "@repo/platform/engine/modules/projects/project.operations";
import { env } from "@repo/platform/engine/config/index";

const cloudProject = {
  id: "cloud-project",
  organizationId: "cloud-org",
  groupId: "cloud-group",
  name: "Cloud app",
  slug: "cloud-app",
  serverId: "cloud-server",
  workspaceId: "cloud-workspace",
  deployTarget: "cloud",
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
};
const app = new Hono()
  .onError(handleApiError)
  .route("/api/projects", projectRoutes)
  .route("/api/apps", appRoutes)
  .route("/api/projects/:id/services", serviceRoutes)
  .route("/api/actions", actionRoutes);
let owner: SeededOwner;
let linkedServerId: string;
const headers = () => ({
  ...owner.auth,
  "X-Organization-Id": owner.orgId,
  "content-type": "application/json",
});
const request = (path: string, body?: unknown) =>
  app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: headers(),
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const ctx = (): ExecutionContext =>
  ({
    userId: owner.userId,
    organizationId: owner.orgId,
    role: "owner",
    scopeMode: "resource",
  }) as ExecutionContext;

beforeEach(async () => {
  vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory");
  h.fetch.mockReset();
  h.linked.clear();
  h.identity.organizationId = "cloud-org";
  owner = await seedOwner({ bound: false });
  h.linked.add(owner.orgId);
  h.identity.organizationId = `cloud-${owner.orgId}`;
  const workspace = await repos.cloudWorkspace.link({
    organizationId: owner.orgId,
    name: "Managed server",
    remote: { ...h.identity, serverId: "cloud-server", workspaceId: "cloud-workspace" },
  });
  linkedServerId = (await repos.server.findByWorkspace(workspace.id, owner.orgId))!.id;
  h.fetch.mockImplementation(async (_org, path) => {
    if (path === "/api/projects/ensure")
      return Response.json({ success: true, project_id: cloudProject.id, created: true });
    if (path === "/api/projects")
      return Response.json(
        { data: { ...cloudProject, organizationId: h.identity.organizationId } },
        { status: 201 },
      );
    if (path === "/api/apps")
      return Response.json({
        data: { kind: "template", projectId: cloudProject.id, slug: cloudProject.slug },
      });
    if (path.startsWith("/api/apps/catalog/wordpress/host-fit?"))
      return Response.json({
        data: {
          minResources: null,
          capacity: { cpuCores: 4, memoryMb: 8192, source: "docker" },
          fit: { ok: true },
          cloud: { status: "ready", resources: { cpuCores: 1, memoryMb: 2048, diskMb: 8192 } },
        },
      });
    return Response.json({ data: [] });
  });
});
afterAll(async () => {
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});

describe("managed Cloud project creation through the connected controller", () => {
  it("runs directly on Cloud itself without forwarding back to the same API", async () => {
    const prior = env.CLOUD_MODE;
    try {
      (env as { CLOUD_MODE: boolean }).CLOUD_MODE = true;
      expect(
        await maybeCloudProjectRequest(
          ctx(),
          "/api/projects",
          { serverId: linkedServerId },
          isProject,
        ),
      ).toBeNull();
      expect(h.fetch).not.toHaveBeenCalled();
    } finally {
      (env as { CLOUD_MODE: boolean }).CLOUD_MODE = prior;
    }
  });

  it("installs an app in Cloud, then sends service and Actions reads to that same owner", async () => {
    const input = {
      templateId: "wordpress",
      name: "Cloud app",
      serverId: linkedServerId,
      routes: [{ service: "wordpress", port: 80, mode: "free", domain: "my-wordpress" }],
    };
    const response = await request("/api/apps", input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { kind: "template", projectId: cloudProject.id, slug: cloudProject.slug },
    });
    const call = h.fetch.mock.calls[0];
    expect(call[0]).toBe(owner.orgId);
    expect(call[1]).toBe("/api/apps");
    expect(JSON.parse(call[2].body)).toEqual({ ...input, serverId: "cloud-server" });
    expect(call[3]).toEqual(h.identity);
    expect((await repos.project.listByOrganization(owner.orgId)).rows).toEqual([]);
    expect((await request(`/api/projects/${cloudProject.id}/services`)).status).toBe(200);
    expect((await request(`/api/actions/workflows?projectId=${cloudProject.id}`)).status).toBe(200);
    expect(h.fetch.mock.calls.map((call) => call[1])).toEqual([
      "/api/apps",
      `/api/projects/${cloudProject.id}/services`,
      `/api/actions/workflows?projectId=${cloudProject.id}`,
    ]);
  });

  it.each(["/api/projects", "/api/projects/ensure"])(
    "creates Git configuration through %s without a local project copy",
    async (path) => {
      const input = {
        name: "Cloud app",
        serverId: linkedServerId,
        gitOwner: "owner",
        gitRepo: "app",
        gitBranch: "main",
      };
      const response = await request(path, input);
      expect(response.status).toBe(path.endsWith("ensure") ? 200 : 201);
      const body = await response.json();
      expect(path.endsWith("ensure") ? body.project_id : body.data.id).toBe(cloudProject.id);
      expect(JSON.parse(h.fetch.mock.calls[0][2].body)).toEqual({
        ...input,
        serverId: "cloud-server",
      });
      expect((await repos.project.listByOrganization(owner.orgId)).rows).toEqual([]);
    },
  );

  it("uses the same target decision in the engine, not only the HTTP controller", async () => {
    const result = await projectDependencies.create(ctx(), {
      name: "Cloud app",
      serverId: linkedServerId,
    });
    expect(result).toMatchObject({ id: cloudProject.id, source: "cloud" });
    expect(await repos.project.findById(cloudProject.id)).toBeUndefined();
  });

  it("previews Cloud capacity with canonical IDs before installing", async () => {
    const response = await request(
      `/api/apps/catalog/wordpress/host-fit?serverId=${linkedServerId}&deployTarget=cloud`,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.cloud.status).toBe("ready");
    expect(h.fetch.mock.calls[0][1]).toBe(
      "/api/apps/catalog/wordpress/host-fit?deployTarget=cloud&serverId=cloud-server",
    );
    expect((await repos.project.listByOrganization(owner.orgId)).rows).toEqual([]);
  });

  it("accepts a canonical Cloud destination without requiring or creating an execution link", async () => {
    const before = await repos.cloudWorkspace.listByOrganization(owner.orgId);
    expect(
      (await request("/api/projects", { name: "Cloud app", serverId: "unlinked-cloud-server" }))
        .status,
    ).toBe(201);
    expect(JSON.parse(h.fetch.mock.calls[0][2].body).serverId).toBe("unlinked-cloud-server");
    expect(await repos.cloudWorkspace.listByOrganization(owner.orgId)).toEqual(before);
  });

  it("preserves an upstream refusal and never falls back to a local install", async () => {
    h.fetch.mockResolvedValue(
      Response.json({ error: "Upgrade this server", code: "PLAN_LIMIT_EXCEEDED" }, { status: 403 }),
    );
    const response = await request("/api/apps", {
      templateId: "wordpress",
      serverId: linkedServerId,
    });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("PLAN_LIMIT_EXCEEDED");
    expect((await repos.project.listByOrganization(owner.orgId)).rows).toEqual([]);
  });

  it.each([null, { data: {} }])(
    "rejects an unavailable or invalid Cloud result without a local write: %j",
    async (body) => {
      h.fetch.mockResolvedValue(body === null ? null : Response.json(body));
      const response = await request("/api/projects", {
        name: "Cloud app",
        serverId: linkedServerId,
      });
      expect(response.status).toBe(body === null ? 503 : 502);
      expect((await repos.project.listByOrganization(owner.orgId)).rows).toEqual([]);
    },
  );

  it("rejects another tenant's link and a changed Cloud identity before sending a mutation", async () => {
    const foreign = await seedOwner();
    const server = await seedServer(foreign.orgId);
    expect((await request("/api/projects", { name: "Cloud app", serverId: server })).status).toBe(
      404,
    );
    h.identity.organizationId = "different-cloud-org";
    const response = await request("/api/projects", {
      name: "Cloud app",
      serverId: linkedServerId,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("CLOUD_SERVER_CONNECTION_CHANGED");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("leaves SSH destinations, local sources and existing local projects under their original controller", async () => {
    const ssh = await seedServer(owner.orgId);
    const group = await repos.projectGroup.create({
      organizationId: owner.orgId,
      name: "Local",
      slug: "local",
    });
    const project = await repos.project.create({
      organizationId: owner.orgId,
      groupId: group.id,
      name: "Local",
      slug: "local",
    });
    for (const input of [
      { serverId: ssh },
      { serverId: linkedServerId, localPath: "/app/source" },
      { serverId: linkedServerId, gitProvider: "upload" },
      { serverId: linkedServerId, gitProvider: "local" },
      { projectId: project.id, serverId: linkedServerId },
      {},
    ])
      expect(await maybeCloudProjectRequest(ctx(), "/api/projects", input, isProject)).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(await repos.project.findById(project.id)).toMatchObject({
      organizationId: owner.orgId,
      workspaceId: null,
    });
  });

  it.each([
    { scopeMode: "fixed" },
    { tokenScope: { tokenId: "limited" } },
    { role: "restricted" },
    { credential: { organizationId: "local-org", readOnly: false } },
  ])(
    "never gives an installation-scoped credential the owner's Cloud session: %j",
    async (restriction) => {
      const result = await maybeCloudProjectRequest(
        { ...ctx(), ...restriction } as ExecutionContext,
        "/api/projects",
        { serverId: linkedServerId },
        isProject,
      );
      expect(result).toBeNull();
      expect(h.fetch).not.toHaveBeenCalled();
    },
  );
});
