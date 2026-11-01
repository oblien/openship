import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FolderSessionResult } from "@repo/contracts";

const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  cloudFetch: vi.fn(),
  kickoff: vi.fn(),
  sessions: new Map<
    string,
    { token: string; apiUrl: string; userId: string; organizationId: string }
  >(),
  owners: new Map<string, string>(),
}));
vi.mock("../../../src/app", () => ({ app: { fetch: h.dispatch } }));
vi.mock("@repo/platform/engine/lib/cloud/transport", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/cloud/transport")>()),
  resolveOrgCloudUserId: async (org: string) => h.owners.get(org) ?? null,
  readCloudSession: async (user: string) => h.sessions.get(user) ?? null,
  cloudFetchAsOrgOwner: h.cloudFetch,
}));
vi.mock("@repo/platform/engine/modules/deployments/preflight", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/deployments/preflight")>()),
  runPreflightChecks: async () => ({ ok: true, checks: [] }),
}));
vi.mock("@repo/platform/engine/modules/deployments/build-pipeline", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/deployments/build-pipeline")>()),
  kickoffBuild: h.kickoff,
}));

import {
  db,
  repos,
  schema,
  seedOwner,
  installFakeRunner,
  type SeededOwner,
} from "../jobs/_harness";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import { cloudRuntimeTarget } from "@repo/platform/engine/config/env";
import { archiveSourceDirectory } from "@repo/platform/source-files";
import { mcpRoutes } from "../../../src/modules/mcp/mcp.routes";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { deploymentRoutes } from "../../../src/modules/deployments/deployment.routes";
import { permissionsRoutes } from "../../../src/modules/permissions/permissions.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { clientIpMiddleware } from "../../../src/middleware/client-ip";
import { shutdownRateLimit } from "../../../src/lib/rate-limit";
import { mcpTestClient } from "../../helpers/mcp-client";
import { deleteFolderSession } from "@repo/platform/engine/modules/projects/folder/session-store";

// Real MCP -> HTTP authentication -> shared authorization/engine, source scans,
// SQL grants, source uploads and deployment snapshots. Only remote provider
// probes and worker execution are simulated; no paid resources are provisioned.
installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .use("*", clientIpMiddleware)
  .route("/api/projects", projectRoutes)
  .route("/api/deployments", deploymentRoutes)
  .route("/api/permissions", permissionsRoutes)
  .route("/api/mcp", mcpRoutes);
let folder: string;
let owner: SeededOwner;
let serverId: string;
const sessions: string[] = [];

beforeAll(async () => {
  vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory");
  vi.stubEnv("OPENSHIP_NATIVE", "false");
  folder = await mkdtemp(join(tmpdir(), "openship-mcp-cloud-"));
  await writeFile(join(folder, "index.html"), "<h1>Desktop to Cloud</h1>");
  await writeFile(
    join(folder, "openship.json"),
    JSON.stringify({ env: { MESSAGE: "from-the-real-source" } }),
  );
  h.dispatch.mockImplementation((request) => app.fetch(request));
});
beforeEach(async () => {
  h.cloudFetch.mockReset();
  h.kickoff.mockReset();
  owner = await seedOwner();
  const identity = {
    apiUrl: cloudRuntimeTarget.api,
    userId: `cloud-${owner.userId}`,
    organizationId: `cloud-${owner.orgId}`,
  };
  const activityPath = `/api/cloud/servers/remote-server-${owner.userId}/activity`;
  h.cloudFetch.mockImplementation(async (organizationId, path, init, expectedIdentity) => {
    expect(organizationId).toBe(owner.orgId);
    expect(expectedIdentity).toMatchObject(identity);
    expect([activityPath, `${activityPath}/release`]).toContain(path);
    expect(init.method).toBe("POST");
    const activity = JSON.parse(init.body);
    return Response.json({
      id: activity.id,
      ...(path.endsWith("/release") ? { released: true } : {}),
    });
  });
  h.owners.set(owner.orgId, owner.userId);
  h.sessions.set(owner.userId, { ...identity, token: "fake-server-side-cloud-session" });
  const workspace = await repos.cloudWorkspace.link({
    organizationId: owner.orgId,
    name: "Connected Cloud server",
    remote: {
      ...identity,
      serverId: `remote-server-${owner.userId}`,
      workspaceId: `remote-workspace-${owner.userId}`,
    },
  });
  serverId = (await repos.server.findByWorkspace(workspace.id, owner.orgId))!.id;
});
afterAll(async () => {
  for (const id of sessions) {
    const session = deleteFolderSession(id);
    if (session?.stagingDir) await rm(session.stagingDir, { recursive: true, force: true });
  }
  await rm(folder, { recursive: true, force: true });
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});

async function agent(withServer = true) {
  const token = mintPatToken();
  const pat = await repos.personalAccessToken.create({
    userId: owner.userId,
    organizationId: owner.orgId,
    name: "MCP own projects",
    tokenPrefix: token.tokenPrefix,
    tokenHash: token.tokenHash,
    readOnly: false,
    scoped: true,
    expiresAt: null,
  });
  await repos.patGrant.createMany(pat.id, [
    { resourceType: "project", resourceId: "*", permissions: ["create"] },
    ...(withServer
      ? [{ resourceType: "server" as const, resourceId: serverId, permissions: ["write" as const] }]
      : []),
  ]);
  const client = mcpTestClient({
    request: (path, init) => app.request(path, init),
    token: token.token,
    organizationId: owner.orgId,
  });
  return { ...client, token: token.token };
}

describe("desktop MCP Cloud workflow", () => {
  it.each([true, false])(
    "deploys a controller-local folder on the connected server (explicit org: %s)",
    async (explicit) => {
      const client = await agent();
      const created = await client.call<{ data: { id: string } }>("post_projects_import", {
        ...(explicit ? {} : { organizationId: undefined }),
        body: { name: "Desktop site", localPath: folder, serverId, publicEndpoints: [] },
      });
      const started = await client.call<{ project_id: string; deployment_id: string }>(
        "post_deployments_build_access",
        {
          ...(explicit ? {} : { organizationId: undefined }),
          body: { projectId: created.data.id, buildStrategy: "server", publicEndpoints: [] },
        },
      );
      const saved = await repos.project.findById(started.project_id);
      expect(saved).toMatchObject({ organizationId: owner.orgId, localPath: folder, serverId });
      expect(saved?.workspaceId).toBeTruthy();
      expect(await repos.deployment.findById(started.deployment_id)).toMatchObject({
        projectId: created.data.id,
        organizationId: owner.orgId,
        meta: {
          localPath: folder,
          serverId,
          deployTarget: "cloud",
          buildStrategy: "server",
          framework: "static",
        },
      });
      const variables = await repos.project.listEnvVars(created.data.id);
      expect(decrypt(variables.find((variable) => variable.key === "MESSAGE")!.value)).toBe(
        "from-the-real-source",
      );
      expect(h.kickoff).toHaveBeenCalledTimes(1);
      // DB-only submission does not acquire host privileges; the detached worker
      // acquires its build activity when it actually starts.
      expect(h.cloudFetch).not.toHaveBeenCalled();
    },
  );

  it("requires destination server permission before creating a project", async () => {
    const client = await agent(false);
    const result = await client.result("post_projects_import", {
      body: { name: "Denied", localPath: folder, serverId },
    });
    expect(result.isError).toBe(true);
    expect((await repos.project.listByOrganization(owner.orgId)).total).toBe(0);
    expect(h.kickoff).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "cannot bypass Cloud record transfer restrictions by omitting organizationId (explicit: %s)",
    async (explicit) => {
      const client = await agent();
      const created = await client.call<{ data: { id: string } }>("post_projects_import", {
        body: { name: "Local", localPath: folder, publicEndpoints: [] },
      });
      const result = await client.result<{ code: string; error: string }>(
        "post_projects_by_id_transfer_to_cloud",
        {
          id: created.data.id,
          ...(explicit ? {} : { organizationId: undefined }),
        },
      );
      expect(result).toMatchObject({ isError: true, data: { code: "CLOUD_SCOPE_UNAVAILABLE" } });
      expect(result.data.error).toContain("serverId");
      expect(await repos.project.findById(created.data.id)).toBeDefined();
      expect(h.cloudFetch).not.toHaveBeenCalled();
    },
  );

  it("explains missing placement and rejects a local build on a managed server before queueing", async () => {
    const client = await agent();
    const local = await client.call<{ data: { id: string } }>("post_projects_import", {
      body: { name: "Unplaced", localPath: folder, publicEndpoints: [] },
    });
    const missing = await client.result("post_deployments_build_access", {
      body: { projectId: local.data.id, deployTarget: "cloud", buildStrategy: "local" },
    });
    expect(missing).toMatchObject({ isError: true, data: { code: "DEPLOYMENT_SERVER_REQUIRED" } });
    const managed = await client.call<{ data: { id: string } }>("post_projects_import", {
      body: { name: "Managed", localPath: folder, serverId, publicEndpoints: [] },
    });
    const invalid = await client.result("post_deployments_build_access", {
      body: { projectId: managed.data.id, buildStrategy: "local" },
    });
    expect(invalid).toMatchObject({
      isError: true,
      data: { code: "MANAGED_SERVER_BUILD_STRATEGY" },
    });
    expect(h.kickoff).not.toHaveBeenCalled();
    expect(h.cloudFetch).not.toHaveBeenCalled();
  });

  it("lets a create-only token upload and scan its own project's source without wildcard write access", async () => {
    const client = await agent();
    expect((await client.result("post_projects_folder_session")).isError).toBe(true);
    const project = await client.call<{ data: { id: string } }>("post_projects", {
      body: { name: "Uploaded site", gitProvider: "upload", serverId, publicEndpoints: [] },
    });
    const projectId = project.data.id;
    const session = await client.call<FolderSessionResult>("post_projects_folder_session", {
      body: { projectId },
    });
    sessions.push(session.sessionId);
    const packed = await archiveSourceDirectory(folder);
    try {
      const upload = await app.request(`/api/projects/folder/upload/${session.sessionId}`, {
        method: "POST",
        headers: {
          ...session.upload.headers,
          Authorization: `Bearer ${client.token}`,
          "X-Organization-Id": owner.orgId,
          "X-Openship-Scope": "fixed",
        },
        body: new Blob([new Uint8Array(await readFile(packed.path))]),
      });
      expect(upload.status, await upload.clone().text()).toBe(200);
    } finally {
      await packed.dispose();
    }
    const scan = await client.call<{ stack: string }>("post_projects_folder_scan_by_sessionId", {
      sessionId: session.sessionId,
    });
    expect(scan.stack).toBe("static");
    const other = await agent();
    expect(
      (
        await other.result("post_projects_folder_scan_by_sessionId", {
          sessionId: session.sessionId,
        })
      ).isError,
    ).toBe(true);
    expect(h.cloudFetch).not.toHaveBeenCalled();
  });
});
