import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(), ssh: vi.fn(), retain: vi.fn(), release: vi.fn(),
  managedExecutor: vi.fn(), managedRuntime: vi.fn(), activity: vi.fn(),
}));
vi.mock("@repo/db", async original => ({ ...(await original<Record<string, unknown>>()),
  repos: { server: { getInOrganization: h.get } },
}));
vi.mock("@repo/platform/engine/config/index", () => ({ env: { CLOUD_MODE: true, DEPLOY_MODE: "docker" } }));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { acquire: h.ssh, retain: h.retain, release: h.release },
  buildSshConfig: async () => ({ host: "8.8.4.9", username: "root", port: 22 }),
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-host", () => ({
  openCloudWorkspaceExecutor: h.managedExecutor, openCloudWorkspaceDockerRuntime: h.managedRuntime,
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-lock", () => ({ withCloudWorkspaceActivity: h.activity }));
import { assertMigrationEndpoints } from "@repo/platform/engine/modules/migration/migration-access";
import { createMigrationDockerRuntime, openMigrationTransferEndpoints, withMigrationActivity } from "@repo/platform/engine/modules/migration/migration-runtime";
import { acquireServerExecution, openServerShell } from "@repo/platform/engine/lib/server-execution";
import { assertDeploymentServer } from "@repo/platform/engine/modules/system/server-access";

const servers = [
  { id: "external-a", organizationId: "org-a", purpose: "migration_source", workspaceId: null, isLocal: false },
  { id: "managed-a", organizationId: "org-a", purpose: "deployment", workspaceId: "workspace-a", isLocal: false },
  { id: "managed-a2", organizationId: "org-a", purpose: "deployment", workspaceId: "workspace-a2", isLocal: false },
  { id: "managed-b", organizationId: "org-b", purpose: "deployment", workspaceId: "workspace-b", isLocal: false },
  { id: "unmanaged-a", organizationId: "org-a", purpose: "deployment", workspaceId: null, isLocal: false },
];
beforeEach(() => {
  vi.clearAllMocks();
  h.get.mockImplementation(async (id, org) => servers.find(server => server.id === id && server.organizationId === org));
  h.ssh.mockResolvedValue({ exec: vi.fn() });
  h.managedExecutor.mockImplementation(async (org, workspace) => ({ identity: `${org}/${workspace}`, dispose: vi.fn() }));
  h.managedRuntime.mockImplementation(async (org, workspace) => ({ identity: `${org}/${workspace}`, dispose: vi.fn() }));
  h.activity.mockImplementation(async (_id, work) => work());
});

describe("Cloud migration endpoint isolation", () => {
  it("checks both organizations before acquiring either endpoint", async () => {
    await expect(openMigrationTransferEndpoints("external-a", "managed-b", "org-a")).rejects.toMatchObject({ statusCode: 404 });
    expect(h.ssh).not.toHaveBeenCalled();
    expect(h.managedExecutor).not.toHaveBeenCalled();
    await expect(createMigrationDockerRuntime("managed-b", "org-a")).rejects.toMatchObject({ statusCode: 404 });
    expect(h.managedRuntime).not.toHaveBeenCalled();
  });

  it("cannot select an external source as a deployment or migration target", async () => {
    expect(() => assertDeploymentServer(servers[0] as never)).toThrow(/migration/i);
    await expect(assertMigrationEndpoints("org-a", "managed-a", "external-a")).rejects.toThrow(/migration/i);
    await expect(acquireServerExecution("org-a", "external-a")).rejects.toThrow(/migration/i);
    await expect(openServerShell("org-a", "external-a")).rejects.toThrow(/migration/i);
    expect(h.ssh).not.toHaveBeenCalled();
    expect(h.managedExecutor).not.toHaveBeenCalled();
  });

  it("does not enable general customer SSH destinations on the Cloud control plane", async () => {
    await expect(assertMigrationEndpoints("org-a", "external-a", "unmanaged-a")).rejects.toMatchObject({ statusCode: 404 });
    await expect(acquireServerExecution("org-a", "unmanaged-a", { migration: true })).rejects.toThrow();
    expect(h.ssh).not.toHaveBeenCalled();
  });

  it("pins each managed runtime to its own organization and server", async () => {
    const [a, b] = await Promise.all([createMigrationDockerRuntime("managed-a", "org-a"), createMigrationDockerRuntime("managed-b", "org-b")]);
    expect(a).not.toBe(b);
    expect(a).toMatchObject({ identity: "org-a/workspace-a" });
    expect(b).toMatchObject({ identity: "org-b/workspace-b" });
    expect(h.managedRuntime.mock.calls).toEqual([["org-a", "workspace-a"], ["org-b", "workspace-b"]]);
  });

  it("releases the source if target acquisition fails", async () => {
    h.managedExecutor.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(openMigrationTransferEndpoints("external-a", "managed-a", "org-a")).rejects.toThrow("provider unavailable");
    expect(h.retain).toHaveBeenCalledWith("external-a");
    expect(h.release).toHaveBeenCalledWith("external-a");
  });

  it("uses a managed command connection without inventing an SSH address", async () => {
    const endpoints = await openMigrationTransferEndpoints("external-a", "managed-a", "org-a");
    expect(endpoints.source.conn).toMatchObject({ host: "8.8.4.9" });
    expect(endpoints.target.conn).toBeNull();
    await endpoints.release();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(endpoints.target.executor.dispose).toHaveBeenCalledTimes(1);
  });

  it("orders two managed admissions consistently, independent of transfer direction", async () => {
    const work = vi.fn(async () => "done");
    await withMigrationActivity("org-a", "managed-a2", "managed-a", "run", work);
    expect(h.activity.mock.calls.map(call => call[0])).toEqual(["workspace-a", "workspace-a2"]);
    expect(h.activity.mock.calls.map(call => call[3])).toEqual([{ scope: "migration:run" }, { scope: "migration:run" }]);
    expect(work).toHaveBeenCalledTimes(1);
  });
});
