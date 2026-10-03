import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Project } from "@repo/db";

const h = vi.hoisted(() => ({
  managed: vi.fn(), entitlement: vi.fn(), owner: vi.fn(), find: vi.fn(), reserve: vi.fn(), attach: vi.fn(), ready: vi.fn(), active: vi.fn(),
  token: vi.fn(), spend: vi.fn(), create: vi.fn(), retry: vi.fn(), get: vi.fn(), start: vi.fn(), resume: vi.fn(),
  permanent: vi.fn(), resize: vi.fn(), wait: vi.fn(), credentials: [] as unknown[],
  inFlight: vi.fn(), discard: vi.fn(), list: vi.fn(), exec: vi.fn(), invalidate: vi.fn(), dispose: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  withAdvisoryLock: async (_key: string, run: () => Promise<unknown>) => run(),
  repos: { project: { findByIdInOrganization: h.owner }, deployment: { findById: h.active, listInFlightByProject: h.inFlight },
    cloudWorkspace: { findByIdInOrganization: h.managed },
    cloudDockerWorkspace: { find: h.find, reserve: h.reserve, attach: h.attach, markReady: h.ready, discardUncreated: h.discard } },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { CLOUD_MODE: true, OBLIEN_API_URL: "https://staging.oblien.test" } }));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({ issueNamespaceToken: h.token }));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ getOrgCloudToken: vi.fn() }));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({ assertCloudCanSpend: h.spend, syncOblienEntitlement: h.entitlement }));
vi.mock("@repo/adapters", async (original) => ({
  ...await original<typeof import("@repo/adapters")>(),
  Oblien: class {
    constructor(credentials: unknown) { h.credentials.push(credentials); }
    workspaces = { create: h.create, retryCreation: h.retry, get: h.get, list: h.list };
    workspace = (id: string) => ({ id, get: h.get, start: h.start, resume: h.resume,
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

import { cloudDockerWorkspaceForCleanup, ensureCloudDockerWorkspace, ensureCloudWorkspaceHost } from "@repo/platform/engine/lib/cloud-docker-workspace";

const project = { id: "project-a", organizationId: "org-a", activeDeploymentId: null, workspaceId: "owner-a", serverId: "server-a" } as Project;
const resources = { cpuCores: 2, memoryMb: 4096, diskMb: 32768 };
const input = { projectId: project.id, organizationId: project.organizationId };
const ownerRef = { ownerWorkspaceId: project.workspaceId! };
let binding: Record<string, any> | undefined;
beforeEach(() => {
  vi.resetAllMocks(); h.credentials.length = 0; binding = undefined;
  h.owner.mockResolvedValue(project);
  h.managed.mockResolvedValue({ id: project.workspaceId, name: "Production", namespace: "namespace-a", organizationId: project.organizationId });
  h.entitlement.mockResolvedValue({ resourceLimits: { max_total_vcpus: 2, max_total_ram_mb: 4096, max_total_disk_gb: 32 } });
  h.token.mockResolvedValue({ token: "short-lived-tenant-token", namespace: "namespace-a" });
  h.find.mockImplementation(async () => {
    if (binding) { binding.resources ??= resources; binding.image ??= "oblien/docker:29"; }
    return binding;
  });
  h.reserve.mockImplementation(async (value) => binding ??= { ...value, provisionKey: "stable-key", workspaceId: null, state: "provisioning" });
  h.attach.mockImplementation(async (_p, _o, _n, id) => { binding!.workspaceId = id; });
  h.ready.mockImplementation(async () => { binding!.state = "ready"; });
  h.create.mockResolvedValue({ id: "workspace-a", namespace: "namespace-a", status: "creating" });
  h.retry.mockResolvedValue({ id: "workspace-a", namespace: "namespace-a", status: "creating" });
  h.get.mockResolvedValue({
    id: "workspace-a",
    namespace: "namespace-a",
    slug: `os-docker-${createHash("sha256").update(project.workspaceId!).digest("hex").slice(0, 24)}`,
    status: "active",
    info: { status: "running" },
    resources: { cpus: 2, memory_mb: 4096, disk_size_mb: 32768 },
  });
  h.wait.mockImplementation(async () => h.get());
  h.exec.mockResolvedValue("");
  h.resize.mockImplementation(async (resources) => {
    const workspace = await h.get();
    workspace.resources = {
      cpus: resources.cpus,
      memory_mb: resources.memory_mb,
      disk_size_mb: resources.disk_size_mb,
    };
    return { success: true, relaunched: true };
  });
  h.inFlight.mockResolvedValue([]);
  h.list.mockResolvedValue({ workspaces: [], total: 0, limit: 100, page: 1 });
  h.discard.mockImplementation(async () => {
    binding = undefined;
  });
});

describe("Subscribed Cloud server provisioning and retry", () => {
  it("uses namespace credentials and stores provider identity before readiness", async () => {
    h.wait.mockImplementation(async () => {
      expect(binding?.workspaceId).toBe("workspace-a");
      expect(h.permanent).not.toHaveBeenCalled();
      return h.get();
    });
    expect(await ensureCloudDockerWorkspace(input)).toEqual({ projectId: "project-a", workspaceId: "workspace-a", ownerWorkspaceId: "owner-a" });
    expect(h.credentials).toEqual([{ token: "short-lived-tenant-token", baseUrl: "https://staging.oblien.test" }]);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ namespace: "namespace-a", image: "oblien/docker:29", wait_ready: false, idempotency_key: "stable-key" }));
    expect(binding?.state).toBe("ready");
    expect(h.permanent).toHaveBeenCalledOnce();
  });
  it("deduplicates simultaneous deployments through the subscribed server lock", async () => {
    const result = await Promise.all([ensureCloudDockerWorkspace(input), ensureCloudDockerWorkspace(input)]);
    expect(result[0]).toEqual(result[1]);
    expect(h.create).toHaveBeenCalledOnce();
  });
  it("replays the identical creation request after an uncertain POST, even if desired resources change", async () => {
    h.create.mockRejectedValueOnce(new Error("connection lost after POST"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("connection lost");
    expect(binding?.workspaceId).toBeNull();
    h.entitlement.mockResolvedValue({ resourceLimits: { max_total_vcpus: 4, max_total_ram_mb: 8192, max_total_disk_gb: 64 } });
    await ensureCloudDockerWorkspace(input);
    expect(h.create.mock.calls[1]![0]).toEqual(h.create.mock.calls[0]![0]);
    expect(h.resize).not.toHaveBeenCalled();
  });
  it("retains the binding on readiness failure and reconnects without creating another disk", async () => {
    h.wait.mockRejectedValueOnce(new Error("still starting"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("still starting");
    expect(binding?.workspaceId).toBe("workspace-a");
    expect(binding?.state).toBe("provisioning");
    await ensureCloudDockerWorkspace(input);
    expect(h.create).toHaveBeenCalledOnce();
  });
  it("retries failed initial provisioning on the same workspace when the deployment is retried", async () => {
    h.wait.mockRejectedValueOnce(new Error("provider boot failed"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("provider boot failed");
    h.get.mockResolvedValueOnce({ id: "workspace-a", namespace: "namespace-a", status: "error", provisioning: { state: "failed" } });
    await expect(ensureCloudDockerWorkspace(input)).resolves.toEqual({ projectId: "project-a", workspaceId: "workspace-a", ownerWorkspaceId: "owner-a" });
    expect(h.retry).toHaveBeenCalledExactlyOnceWith("workspace-a");
    expect(h.create).toHaveBeenCalledOnce();
    expect(binding?.state).toBe("ready");
  });
  it("does not retry creation for a previously ready workspace with customer data", async () => {
    await ensureCloudDockerWorkspace(input);
    h.get.mockResolvedValue({ id: "workspace-a", namespace: "namespace-a", status: "error", provisioning: { state: "failed" } });
    h.wait.mockRejectedValue(new Error("provider boot failed"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("provider boot failed");
    expect(h.retry).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledOnce();
  });
  it("verifies the workspace returned from a provisioning retry", async () => {
    h.wait.mockRejectedValueOnce(new Error("provider boot failed"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("provider boot failed");
    h.get.mockResolvedValueOnce({ id: "workspace-a", namespace: "namespace-a", status: "error", provisioning: { state: "failed" } });
    h.retry.mockResolvedValue({ id: "workspace-other", namespace: "namespace-other" });
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("unexpected workspace");
    expect(binding?.workspaceId).toBe("workspace-a");
    expect(binding?.state).toBe("provisioning");
  });
  it("discards an empty reservation only after a definitive provider rejection", async () => {
    h.create.mockRejectedValueOnce(Object.assign(new Error("resource allowance exceeded"), { status: 403 }));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("resource allowance");
    expect(h.discard).toHaveBeenCalledWith(ownerRef, project.organizationId, "stable-key");
    expect(binding).toBeUndefined();
  });
  it("does not replace an old request when an empty lookup cannot rule out earlier provisioning", async () => {
    binding = { ...input, namespace: "namespace-a", resources: { ...resources, cpuCores: 5 },
      provisionKey: "legacy-key", workspaceId: null, state: "provisioning" };
    h.create.mockImplementation(async (request) => {
      if (request.config.cpus > 4) {
        throw Object.assign(new Error("namespace permits 4 vCPU"), {
          status: 409, code: "NAMESPACE_LIMIT_REACHED",
        });
      }
      return { id: "workspace-a", namespace: "namespace-a" };
    });
    await expect(ensureCloudDockerWorkspace(input))
      .rejects.toMatchObject({ code: "NAMESPACE_LIMIT_REACHED" });
    expect(h.create.mock.calls.map(([request]) => request.config.cpus)).toEqual([5]);
    expect(h.create.mock.calls.map(([request]) => request.idempotency_key)).toEqual(["legacy-key"]);
    expect(h.list).toHaveBeenCalled();
    expect(h.discard).not.toHaveBeenCalled();
    expect(binding?.state).toBe("provisioning");
  });
  it("adopts an earlier workspace discovered after a quota refusal instead of creating another", async () => {
    binding = { ...input, namespace: "namespace-a", provisionKey: "legacy-key", workspaceId: null, state: "provisioning" };
    h.create.mockRejectedValue(Object.assign(new Error("namespace workspace limit"), { status: 409, code: "NAMESPACE_LIMIT_REACHED" }));
    h.list.mockResolvedValue({ workspaces: [await h.get()], total: 1, limit: 100, page: 1 });
    await expect(ensureCloudDockerWorkspace(input)).resolves.toEqual({ projectId: project.id, workspaceId: "workspace-a", ownerWorkspaceId: "owner-a" });
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it("retains an old reservation when a quota refusal cannot be reconciled with provider state", async () => {
    binding = { ...input, namespace: "namespace-a", provisionKey: "legacy-key", workspaceId: null, state: "provisioning" };
    h.create.mockRejectedValue(Object.assign(new Error("namespace workspace limit"), { status: 409, code: "NAMESPACE_LIMIT_REACHED" }));
    h.list.mockRejectedValue(new Error("provider lookup unavailable"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("provider lookup unavailable");
    expect(binding?.provisionKey).toBe("legacy-key");
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it("searches all pages and recovers only the workspace in this project's namespace", async () => {
    binding = { ...input, namespace: "namespace-a", provisionKey: "legacy-key", workspaceId: null, state: "provisioning" };
    h.create.mockRejectedValue(Object.assign(new Error("namespace workspace limit"), { status: 409, code: "NAMESPACE_LIMIT_REACHED" }));
    const workspace = await h.get();
    h.list.mockResolvedValueOnce({ workspaces: [{ ...workspace, namespace: "other-namespace", id: "foreign-vm" }], total: 2, limit: 1, page: 1 });
    h.list.mockResolvedValueOnce({ workspaces: [workspace], total: 2, limit: 1, page: 2 });
    await expect(ensureCloudDockerWorkspace(input)).resolves.toMatchObject({ workspaceId: "workspace-a" });
    expect(h.list).toHaveBeenNthCalledWith(2, { page: 2, limit: 100 });
    expect(h.attach).toHaveBeenCalledExactlyOnceWith(ownerRef, project.organizationId, "namespace-a", "workspace-a");
  });
  it("refuses an ambiguous provider identity instead of selecting one disk arbitrarily", async () => {
    binding = { ...input, namespace: "namespace-a", provisionKey: "legacy-key", workspaceId: null, state: "provisioning" };
    h.create.mockRejectedValue(Object.assign(new Error("namespace workspace limit"), { status: 409, code: "NAMESPACE_LIMIT_REACHED" }));
    const workspace = await h.get();
    h.list.mockResolvedValue({ workspaces: [workspace, { ...workspace, id: "duplicate-vm" }], total: 2, limit: 100, page: 1 });
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("Multiple Cloud servers");
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it.each([
    "NAMESPACE_LIMIT_REACHED",
    "SANDBOX_LIMIT_REACHED",
    "POOL_LIMIT_REACHED",
    "plan_limit_exceeded",
    "namespace_limit_exceeded",
  ])("leaves a rejected %s installation deletable without creating a workspace", async (code) => {
    const error = Object.assign(new Error("creation rejected"), { status: 409, code });
    h.create.mockRejectedValueOnce(error);
    await expect(ensureCloudDockerWorkspace(input)).rejects.toBe(error);
    expect(
      await cloudDockerWorkspaceForCleanup(project.id, project.organizationId),
    ).toBeUndefined();
    expect(binding).toBeUndefined();
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.start).not.toHaveBeenCalled();
  });
  it("keeps an unclassified conflict reserved instead of assuming no workspace exists", async () => {
    h.create.mockRejectedValueOnce(
      Object.assign(new Error("create already in progress"), {
        status: 409,
        code: "CREATE_IN_PROGRESS",
      }),
    );
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("already in progress");
    expect(binding?.provisionKey).toBe("stable-key");
    expect(h.discard).not.toHaveBeenCalled();
  });
  it("releases a new reservation if cancelled before the provider request", async () => {
    const controller = new AbortController();
    const reserve = h.reserve.getMockImplementation()!;
    h.reserve.mockImplementationOnce(async (...args) => {
      const result = await reserve(...args);
      controller.abort(new Error("install cancelled"));
      return result;
    });
    await expect(
      ensureCloudDockerWorkspace({ ...input, signal: controller.signal }),
    ).rejects.toThrow("install cancelled");
    expect(h.create).not.toHaveBeenCalled();
    expect(
      await cloudDockerWorkspaceForCleanup(project.id, project.organizationId),
    ).toBeUndefined();
  });
  it("preserves an earlier uncertain request when a retry is cancelled before sending", async () => {
    h.create.mockRejectedValueOnce(new Error("response lost"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("response lost");
    const controller = new AbortController();
    h.token.mockImplementationOnce(async () => {
      controller.abort(new Error("retry cancelled"));
      return { token: "short-lived-tenant-token", namespace: "namespace-a" };
    });
    await expect(
      ensureCloudDockerWorkspace({ ...input, signal: controller.signal }),
    ).rejects.toThrow("retry cancelled");
    expect(binding?.provisionKey).toBe("stable-key");
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledOnce();
  });
  it("tracks a failed creation's returned workspace so deletion can reclaim it", async () => {
    const error = Object.assign(new Error("initial provisioning failed"), {
      status: 422,
      code: "CREATE_FAILED",
      details: { workspace_id: "workspace-a" },
    });
    h.create.mockRejectedValueOnce(error);
    await expect(ensureCloudDockerWorkspace(input)).rejects.toBe(error);
    expect(await cloudDockerWorkspaceForCleanup(project.id, project.organizationId)).toMatchObject({
      workspaceId: "workspace-a",
      state: "provisioning",
    });
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.wait).not.toHaveBeenCalled();
  });
  it("does not release a previous uncertain request when its retry is rejected", async () => {
    h.create.mockRejectedValueOnce(new Error("response lost"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("response lost");
    h.create.mockRejectedValueOnce(Object.assign(new Error("token expired"), { status: 401 }));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("token expired");
    expect(binding?.provisionKey).toBe("stable-key");
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });
  it("keeps an unclassified provisioning failure reserved when no identity is returned", async () => {
    h.create.mockRejectedValueOnce(
      Object.assign(new Error("provisioning failed"), {
        status: 422,
        code: "CREATE_FAILED",
      }),
    );
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("provisioning failed");
    expect(binding?.provisionKey).toBe("stable-key");
    expect(h.discard).not.toHaveBeenCalled();
  });
  it.each([
    { namespace: "another-namespace" },
    { slug: "another-project" },
    { id: "another-workspace" },
  ])("never adopts a failed resource with mismatching ownership: %j", async (mismatch) => {
    h.create.mockRejectedValueOnce(
      Object.assign(new Error("creation failed"), {
        status: 422,
        details: { workspace_id: "workspace-a" },
      }),
    );
    const created = await h.get();
    h.get.mockResolvedValueOnce({ ...created, ...mismatch });
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("ownership");
    expect(binding?.workspaceId).toBeNull();
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.attach).not.toHaveBeenCalled();
  });
  it.each(["stopped", "paused"])("resumes an existing %s VM whose record is active", async state => {
    await ensureCloudDockerWorkspace(input);
    h.get.mockResolvedValue({ namespace: "namespace-a", status: "active", info: { status: state } });
    await ensureCloudDockerWorkspace(input);
    expect(state === "stopped" ? h.start : h.resume).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledOnce();
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
  it("reuses the recorded server for a service add without resizing or creating another host", async () => {
    await ensureCloudDockerWorkspace(input);
    h.reserve.mockClear(); h.create.mockClear();
    await ensureCloudDockerWorkspace({ ...input, existingWorkspaceId: "workspace-a" });
    expect(h.resize).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(binding?.workspaceId).toBe("workspace-a");
  });
  it.each(["missing", "different"])("refuses a service add with a %s workspace binding before provider access", async state => {
    if (state === "different") binding = { namespace: "namespace-a", workspaceId: "another-workspace", resources };
    await expect(ensureCloudDockerWorkspace({ ...input, existingWorkspaceId: "workspace-a" }))
      .rejects.toMatchObject({ code: "CLOUD_WORKSPACE_NOT_FOUND" });
    expect(h.token).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.resize).not.toHaveBeenCalled();
  });
  it("refuses a service add when namespace ownership no longer matches", async () => {
    binding = { namespace: "another-namespace", workspaceId: "workspace-a", resources };
    await expect(ensureCloudDockerWorkspace({ ...input, existingWorkspaceId: "workspace-a" }))
      .rejects.toThrow("namespace binding");
    expect(h.get).not.toHaveBeenCalled();
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
  it("provisions before the first project and reuses that subscribed host for deployments", async () => {
    expect(await ensureCloudWorkspaceHost({ organizationId: project.organizationId, ...ownerRef })).toBe("workspace-a");
    expect(h.owner).not.toHaveBeenCalled();
    expect(await ensureCloudDockerWorkspace(input)).toMatchObject({ ownerWorkspaceId: project.workspaceId, workspaceId: "workspace-a" });
    h.owner.mockResolvedValue({ ...project, id: "project-b" });
    await ensureCloudDockerWorkspace({ ...input, projectId: "project-b" });
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.resize).not.toHaveBeenCalled();
  });
  it("cleanup only reads the shared binding and never reclaims the subscription's disk", async () => {
    binding = { namespace: "namespace-a", workspaceId: "workspace-a", ...ownerRef };
    expect(await cloudDockerWorkspaceForCleanup(project.id, project.organizationId)).toBe(binding);
    expect(h.token).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });
  it("requires a server instead of implicitly promoting an unbound project into Cloud", async () => {
    h.owner.mockResolvedValue({ ...project, workspaceId: null, serverId: null });
    await expect(ensureCloudDockerWorkspace(input)).rejects.toMatchObject({ code: "DEPLOYMENT_SERVER_REQUIRED" });
    expect(h.token).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
});
