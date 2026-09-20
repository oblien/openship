import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@repo/db";

const h = vi.hoisted(() => ({
  owner: vi.fn(), find: vi.fn(), reserve: vi.fn(), attach: vi.fn(), ready: vi.fn(), active: vi.fn(),
  token: vi.fn(), spend: vi.fn(), create: vi.fn(), get: vi.fn(), start: vi.fn(), resume: vi.fn(),
  permanent: vi.fn(), resize: vi.fn(), wait: vi.fn(), credentials: [] as unknown[],
  discard: vi.fn(), list: vi.fn(), exec: vi.fn(), invalidate: vi.fn(), dispose: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  withAdvisoryLock: async (_key: string, run: () => Promise<unknown>) => run(),
  repos: { project: { findByIdInOrganization: h.owner }, deployment: { findById: h.active },
    cloudDockerWorkspace: { find: h.find, reserve: h.reserve, attach: h.attach, markReady: h.ready, discardUncreated: h.discard } },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { CLOUD_MODE: true, OBLIEN_API_URL: "https://staging.oblien.test" } }));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({ issueNamespaceToken: h.token }));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ getOrgCloudToken: vi.fn() }));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({ assertCloudCanSpend: h.spend }));
vi.mock("@repo/adapters", async (original) => ({
  ...await original<typeof import("@repo/adapters")>(),
  Oblien: class {
    constructor(credentials: unknown) { h.credentials.push(credentials); }
    workspaces = { create: h.create, get: h.get, list: h.list };
    workspace = () => ({ get: h.get, start: h.start, resume: h.resume,
      lifecycle: { makePermanent: h.permanent }, resources: { update: h.resize },
      runtime: async () => ({ exec: { run: h.exec } }), invalidateRuntime: h.invalidate });
  },
  waitForCloudDockerWorkspace: h.wait,
  CloudWorkspaceExecutor: class {
    exec = h.exec;
    dispose = h.dispose;
    runWithAbortSignal(signal: AbortSignal, run: () => Promise<unknown>) { signal.throwIfAborted(); return run(); }
  },
}));

import { cloudDockerResources, cloudDockerWorkspaceForCleanup, ensureCloudDockerWorkspace, usesCloudDockerWorkspace } from "@repo/platform/engine/lib/cloud-docker-workspace";

const project = { id: "project-a", organizationId: "org-a", activeDeploymentId: null, cloudWorkspaceId: null } as Project;
const resources = { cpuCores: 2, memoryMb: 4096, diskMb: 32768 };
const input = { projectId: project.id, organizationId: project.organizationId, resources };
let binding: Record<string, any> | undefined;
beforeEach(() => {
  vi.resetAllMocks(); h.credentials.length = 0; binding = undefined;
  h.owner.mockResolvedValue(project);
  h.token.mockResolvedValue({ token: "short-lived-tenant-token", namespace: "namespace-a" });
  h.find.mockImplementation(async () => binding);
  h.reserve.mockImplementation(async (value) => binding ??= { ...value, provisionKey: "stable-key", workspaceId: null, state: "provisioning" });
  h.attach.mockImplementation(async (_p, _o, _n, id) => { binding!.workspaceId = id; });
  h.ready.mockImplementation(async () => { binding!.state = "ready"; });
  h.create.mockResolvedValue({ id: "workspace-a", namespace: "namespace-a", status: "creating" });
  h.get.mockResolvedValue({ id: "workspace-a", namespace: "namespace-a", status: "active", info: { status: "running" }, resources: { cpus: 2, memory_mb: 4096, disk_size_mb: 32768 } });
  h.wait.mockImplementation(async () => h.get());
  h.exec.mockResolvedValue("");
  h.discard.mockImplementation(async () => { binding = undefined; });
});

describe("Cloud Docker provisioning and retry", () => {
  it("uses namespace credentials and stores provider identity before readiness", async () => {
    h.wait.mockImplementation(async () => {
      expect(binding?.workspaceId).toBe("workspace-a");
      expect(h.permanent).not.toHaveBeenCalled();
      return h.get();
    });
    expect(await ensureCloudDockerWorkspace(input)).toEqual({ projectId: "project-a", workspaceId: "workspace-a" });
    expect(h.credentials).toEqual([{ token: "short-lived-tenant-token", baseUrl: "https://staging.oblien.test" }]);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ namespace: "namespace-a", image: "oblien/docker:29", wait_ready: false, idempotency_key: "stable-key" }));
    expect(binding?.state).toBe("ready");
    expect(h.permanent).toHaveBeenCalledOnce();
  });
  it("deduplicates simultaneous first deployments through the project lock", async () => {
    const result = await Promise.all([ensureCloudDockerWorkspace(input), ensureCloudDockerWorkspace(input)]);
    expect(result[0]).toEqual(result[1]);
    expect(h.create).toHaveBeenCalledOnce();
  });
  it("replays the identical creation request after an uncertain POST, even if desired resources change", async () => {
    h.create.mockRejectedValueOnce(new Error("connection lost after POST"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("connection lost");
    expect(binding?.workspaceId).toBeNull();
    await ensureCloudDockerWorkspace({ ...input, resources: { ...resources, memoryMb: 8192 } });
    expect(h.create.mock.calls[1]![0]).toEqual(h.create.mock.calls[0]![0]);
    expect(h.resize).toHaveBeenCalledWith(expect.objectContaining({ memory_mb: 8192 }));
  });
  it("retains the binding on readiness failure and reconnects without creating another disk", async () => {
    h.wait.mockRejectedValueOnce(new Error("still starting"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("still starting");
    expect(binding?.workspaceId).toBe("workspace-a");
    expect(binding?.state).toBe("provisioning");
    await ensureCloudDockerWorkspace(input);
    expect(h.create).toHaveBeenCalledOnce();
  });
  it("discards an empty reservation only after a definitive provider rejection", async () => {
    h.create.mockRejectedValueOnce(Object.assign(new Error("resource allowance exceeded"), { status: 403 }));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("resource allowance");
    expect(h.discard).toHaveBeenCalledWith(project.id, project.organizationId, "stable-key");
    expect(binding).toBeUndefined();
  });
  it("applies a larger allocation and restores only previously running containers", async () => {
    await ensureCloudDockerWorkspace(input);
    h.exec.mockResolvedValueOnce("abcdef123456\r\n123456abcdef\r\n");
    await ensureCloudDockerWorkspace({ ...input, resources: { ...resources, memoryMb: 8192 } });
    expect(h.resize).toHaveBeenCalledWith({ cpus: 2, memory_mb: 8192, disk_size_mb: 32768, apply: true });
    expect(h.exec).toHaveBeenLastCalledWith("docker start 'abcdef123456' '123456abcdef'");
    expect(h.invalidate).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledOnce();
  });
  it.each(["stopped", "paused"])("resumes an existing %s VM whose record is active", async state => {
    await ensureCloudDockerWorkspace(input);
    h.get.mockResolvedValue({ namespace: "namespace-a", status: "active", info: { status: state } });
    await ensureCloudDockerWorkspace(input);
    expect(state === "stopped" ? h.start : h.resume).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledOnce();
  });
  it("finishes recovering services when a deployment is cancelled during a resize", async () => {
    await ensureCloudDockerWorkspace(input);
    const controller = new AbortController();
    h.exec.mockResolvedValueOnce("abcdef123456");
    h.resize.mockImplementation(async () => { controller.abort(); });
    await expect(ensureCloudDockerWorkspace({ ...input, resources: { ...resources, memoryMb: 8192 }, signal: controller.signal })).rejects.toThrow();
    expect(h.exec).toHaveBeenLastCalledWith("docker start 'abcdef123456'");
    expect(h.wait).toHaveBeenLastCalledWith(expect.anything(), "workspace-a", "namespace-a");
    expect(h.dispose).toHaveBeenCalledOnce();
  });
  it("restores running services after a resize response is lost and still reports the failure", async () => {
    await ensureCloudDockerWorkspace(input);
    h.exec.mockResolvedValueOnce("abcdef123456");
    h.resize.mockRejectedValue(new Error("response lost after resizing the VM"));
    await expect(ensureCloudDockerWorkspace({ ...input, resources: { ...resources, memoryMb: 8192 } }))
      .rejects.toThrow("response lost");
    expect(h.exec).toHaveBeenLastCalledWith("docker start 'abcdef123456'");
    expect(h.invalidate).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledOnce();
  });
  it("recovers an interrupted create for deletion without starting or replacing it", async () => {
    h.create.mockRejectedValueOnce(new Error("response lost"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("response lost");
    const create = h.create.mock.calls[0]![0];
    h.list.mockResolvedValue({ workspaces: [{ id: "recovered-vm", slug: create.slug, namespace: "namespace-a" }], total: 1, limit: 100, page: 1 });
    expect(await cloudDockerWorkspaceForCleanup(project.id, project.organizationId)).toMatchObject({ workspaceId: "recovered-vm" });
    expect(h.attach).toHaveBeenCalledWith(project.id, project.organizationId, "namespace-a", "recovered-vm", true);
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.spend).toHaveBeenCalledOnce();
  });
  it("keeps an unknown creation outcome visible when deletion cannot find its workspace", async () => {
    binding = { namespace: "namespace-a", workspaceId: null, provisionKey: "stable-key" };
    h.list.mockResolvedValue({ workspaces: [], total: 0, limit: 100, page: 1 });
    await expect(cloudDockerWorkspaceForCleanup(project.id, project.organizationId)).rejects.toThrow("not yet confirmed");
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it("records the workspace even when cancellation arrives during creation", async () => {
    const controller = new AbortController();
    h.create.mockImplementation(async () => { controller.abort(); return { id: "workspace-a", namespace: "namespace-a" }; });
    await expect(ensureCloudDockerWorkspace({ ...input, signal: controller.signal })).rejects.toThrow();
    expect(binding?.workspaceId).toBe("workspace-a");
    expect(h.permanent).not.toHaveBeenCalled();
  });
  it("does not replace a missing persisted workspace with an empty disk", async () => {
    binding = { ...input, namespace: "namespace-a", workspaceId: "workspace-missing", resources, provisionKey: "stable-key" };
    h.get.mockRejectedValue(Object.assign(new Error("workspace missing"), { status: 404 }));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("workspace missing");
    expect(h.create).not.toHaveBeenCalled();
  });
  it("rejects wrong namespace ownership and blocks new spending before provisioning", async () => {
    h.create.mockResolvedValue({ id: "workspace-other", namespace: "namespace-other" });
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("unexpected workspace namespace");
    expect(h.attach).not.toHaveBeenCalled();
    h.spend.mockRejectedValue(new Error("out of credits"));
    h.create.mockClear();
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("out of credits");
    expect(h.create).not.toHaveBeenCalled();
  });
  it("keeps native cloud projects and independent single-app services on their existing model", async () => {
    expect(await usesCloudDockerWorkspace(project, "services")).toBe(true);
    expect(await usesCloudDockerWorkspace(project, "single")).toBe(false);
    expect(await usesCloudDockerWorkspace({ ...project, cloudWorkspaceId: "native-workspace" }, "services")).toBe(false);
    h.active.mockResolvedValue({ id: "old", projectId: project.id, organizationId: project.organizationId, meta: { deployTarget: "cloud" } });
    expect(await usesCloudDockerWorkspace({ ...project, activeDeploymentId: "old" }, "services")).toBe(false);
  });
  it("sizes one host for enabled services and build headroom", () => {
    expect(cloudDockerResources({ services: [{ resources: { cpuCores: 1, memoryMb: 3072, diskMb: 1024 } },
      { resources: { cpuCores: 1, memoryMb: 3072, diskMb: 1024 } }, { enabled: false, resources: { cpuCores: 100, memoryMb: 999999, diskMb: 999999 } }],
      buildResources: { cpuCores: 2, memoryMb: 1024, diskMb: 4096 } })).toEqual({ cpuCores: 2, memoryMb: 7168, diskMb: 32768 });
  });
});
