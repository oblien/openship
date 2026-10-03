import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  server: vi.fn(),
  workspaceServer: vi.fn(),
  workspace: vi.fn(),
  binding: vi.fn(),
  create: vi.fn(),
  issueToken: vi.fn(),
  ssh: vi.fn(),
  project: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", async (original) => ({
  ...(await original<any>()),
  env: { CLOUD_MODE: true, OBLIEN_API_URL: "https://provider.test" },
}));
vi.mock("@repo/db", () => ({
  repos: {
    server: { getInOrganization: h.server, findByWorkspace: h.workspaceServer },
    cloudWorkspace: { findByIdInOrganization: h.workspace },
    cloudDockerWorkspace: { find: h.binding },
    project: { findByIdInOrganization: h.project },
  },
}));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({ issueNamespaceToken: h.issueToken }));
vi.mock("@repo/platform/engine/lib/cloud-tenant-admin", () => ({
  createTenantCloudAdmin: () => ({}),
}));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({
  assertCloudCanSpend: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({ sshManager: { acquire: h.ssh } }));
vi.mock("@repo/platform/engine/lib/platform-config", () => ({
  platform: () => ({ target: "cloud", runtime: { name: "cloud" } }),
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<any>()),
  createPlatform: h.create,
}));

import {
  resolveDeploymentPlatform,
  resolveExecutionDestination,
  resolveServerExecutor,
} from "@repo/platform/engine/lib/deployment-runtime";
import { isLocalHostRow } from "@repo/platform/engine/lib/box-org";

const server = {
  id: "managed-server",
  workspaceId: "owner",
  organizationId: "org",
  isLocal: false,
  sshHost: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  h.project.mockResolvedValue({ id: "project", organizationId: "org", serverId: server.id, workspaceId: "owner" });
  h.server.mockResolvedValue(server);
  h.workspaceServer.mockResolvedValue(server);
  h.workspace.mockResolvedValue({
    id: "owner",
    organizationId: "org",
    runtime: "native",
    mode: "dedicated",
  });
  h.binding.mockResolvedValue({
    projectId: null,
    ownerWorkspaceId: "owner",
    workspaceId: "provider-vm",
    namespace: "tenant",
  });
  h.issueToken.mockResolvedValue({ token: "test-token", namespace: "tenant" });
  h.create.mockImplementation(async (config) => ({
    target: "cloud",
    runtime: { name: config.runtime },
    routing: {},
    executor: null,
  }));
});

describe("managed server execution destinations", () => {
  it("uses a retained deployment's owned server after the project has moved", async () => {
    h.project.mockResolvedValue({ id: "project", organizationId: "org", serverId: "new-server", workspaceId: "new-owner" });
    await resolveDeploymentPlatform({ serverId: server.id, runtimeMode: "docker", managedWorkspaceId: "owner",
      managedServer: { projectId: "project", workspaceId: "provider-vm", ownerWorkspaceId: "owner" } }, { organizationId: "org" });
    expect(h.project).toHaveBeenCalledExactlyOnceWith("project", "org");
    expect(h.binding).toHaveBeenCalledWith({ ownerWorkspaceId: "owner" }, "org");
    expect(h.issueToken).toHaveBeenCalledExactlyOnceWith("org", "owner");
    expect(h.create.mock.calls[0][0].cloudServer).toMatchObject({ projectId: "project", workspaceId: "provider-vm", ownerWorkspaceId: "owner" });
  });
  it("rejects retained deployments belonging to a project outside the active organization", async () => {
    h.project.mockResolvedValue(null);
    await expect(resolveDeploymentPlatform({ serverId: server.id, runtimeMode: "docker", managedWorkspaceId: "owner",
      managedServer: { projectId: "foreign-project", workspaceId: "provider-vm", ownerWorkspaceId: "owner" } }, { organizationId: "org" }))
      .rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(h.issueToken).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it("uses the shared BareRuntime for direct applications on a managed server", async () => {
    const resolved = await resolveDeploymentPlatform({ serverId: server.id, runtimeMode: "bare",
      managedServer: { projectId: "project", workspaceId: "provider-vm", ownerWorkspaceId: "owner" } }, { organizationId: "org" });
    expect(resolved).toMatchObject({ serverId: server.id, effectiveTarget: "cloud", platform: { runtime: { name: "bare" } } });
    expect(h.server).toHaveBeenCalledExactlyOnceWith(server.id, "org");
    expect(h.issueToken).toHaveBeenCalledExactlyOnceWith("org", "owner");
    expect(h.create.mock.calls[0][0].cloudServer.workspaceId).toBe("provider-vm");
    expect(h.ssh).not.toHaveBeenCalled();
  });
  it("resolves shared Docker through the same destination and existing Docker adapter", async () => {
    h.workspace.mockResolvedValue({
      id: "owner",
      organizationId: "org",
      runtime: "docker",
      mode: "shared",
    });
    const resolved = await resolveDeploymentPlatform(
      {
        serverId: server.id,
        runtimeMode: "docker",
        managedServer: {
          projectId: "project",
          workspaceId: "provider-vm",
          ownerWorkspaceId: "owner",
        },
      },
      { organizationId: "org" },
    );
    expect(resolved).toMatchObject({
      serverId: server.id,
      effectiveTarget: "cloud",
      platform: { runtime: { name: "docker" } },
    });
    expect(h.create.mock.calls[0][0].cloudServer).toMatchObject({
      projectId: "project",
      ownerWorkspaceId: "owner",
      workspaceId: "provider-vm",
    });
    expect(h.server).toHaveBeenCalledTimes(1);
    expect(h.ssh).not.toHaveBeenCalled();
  });
  it("rejects another organization before requesting provider credentials", async () => {
    h.server.mockResolvedValue(undefined);
    await expect(
      resolveDeploymentPlatform({ serverId: server.id }, { organizationId: "foreign" }),
    ).rejects.toMatchObject({ code: "SERVER_TARGET_UNAVAILABLE" });
    expect(h.issueToken).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it.each([
    { managedWorkspaceId: "different-owner" },
    { deployTarget: "local" },
    { clusterId: "cluster" },
    {
      managedServer: {
        projectId: "project",
        workspaceId: "provider-vm",
        ownerWorkspaceId: "different-owner",
      },
    },
  ])("rejects conflicting ownership or placement: %j", async (conflict) => {
    await expect(
      resolveDeploymentPlatform({ serverId: server.id, ...conflict } as any, {
        organizationId: "org",
      }),
    ).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_TARGET_CONFLICT" });
    expect(h.issueToken).not.toHaveBeenCalled();
    expect(h.ssh).not.toHaveBeenCalled();
  });
  it("cannot use a managed server as an SSH or control-plane-local host", async () => {
    await expect(resolveServerExecutor(server.id, "org")).rejects.toMatchObject({
      code: "MANAGED_SERVER_CONTEXT_REQUIRED",
    });
    expect(await isLocalHostRow({ ...server, isLocal: true, sshHost: "127.0.0.1" })).toBe(false);
    expect(h.ssh).not.toHaveBeenCalled();
  });
  it("resolves an owner snapshot to the workspace's stable server identity", async () => {
    const destination = await resolveExecutionDestination(
      { managedWorkspaceId: "owner", deployTarget: "cloud" },
      "org",
    );
    expect(destination.snapshot).toMatchObject({
      serverId: server.id,
      managedWorkspaceId: "owner",
      deployTarget: "cloud",
    });
    expect(h.workspaceServer).toHaveBeenCalledExactlyOnceWith("owner", "org");
  });
  it("refuses an unbound Cloud target before obtaining credentials or selecting a local runtime", async () => {
    await expect(resolveDeploymentPlatform({ deployTarget: "cloud" }, { organizationId: "org" }))
      .rejects.toMatchObject({ code: "DEPLOYMENT_SERVER_REQUIRED" });
    expect(h.issueToken).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.ssh).not.toHaveBeenCalled();
  });
});
