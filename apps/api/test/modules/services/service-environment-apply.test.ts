import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "@repo/adapters";
import type { Project, Service, Deployment, ServiceDeployment } from "@repo/db";

const h = vi.hoisted(() => ({
  project: vi.fn(), services: vi.fn(), deployment: vi.fn(), rows: vi.fn(), inFlight: vi.fn(), env: vi.fn(),
  record: vi.fn(), createDeployment: vi.fn(), createBuildSession: vi.fn(),
  resolveRuntime: vi.fn(), liveContainer: vi.fn(), cloud: { CLOUD_MODE: false },
  plan: vi.fn(), quota: vi.fn(), limits: vi.fn(),
}));
vi.mock("@repo/db", async original => ({
  ...await original<typeof import("@repo/db")>(),
  withAdvisoryLock: async (_key: string, run: () => Promise<unknown>) => run(),
  repos: {
    project: { findById: h.project, getEnvMap: h.env },
    service: { listByProject: h.services, listByDeployment: h.rows, recordEnvironmentApply: h.record },
    deployment: { findById: h.deployment, listInFlightByProject: h.inFlight, create: h.createDeployment, createBuildSession: h.createBuildSession },
  },
}));
vi.mock("@repo/platform/engine/config/env", async original => ({
  ...await original<typeof import("@repo/platform/engine/config/env")>(),
  env: h.cloud,
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async original => ({
  ...await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>(),
  resolveDeploymentRuntimeForRead: h.resolveRuntime,
}));
vi.mock("@repo/platform/engine/modules/services/service-container", async original => ({
  ...await original<typeof import("@repo/platform/engine/modules/services/service-container")>(),
  liveContainerIdWithRuntime: h.liveContainer,
}));
vi.mock("@repo/platform/engine/lib/encryption", () => ({ decryptEnvMap: (values: Record<string, string>) => values }));
vi.mock("@repo/platform/engine/lib/plan-guard", async original => ({
  ...await original<typeof import("@repo/platform/engine/lib/plan-guard")>(),
  assertPlanAllowsServices: h.plan, assertRunningServiceQuota: h.quota, assertCloudRuntimeLimits: h.limits,
}));

import { applyServiceEnvironment } from "@repo/platform/engine/modules/services/service-environment";

const project = { id: "p1", organizationId: "org1", slug: "demo", activeDeploymentId: "d1", isControlPlane: false } as Project;
const service = { id: "api", name: "api", projectId: "p1", enabled: true, exposedPort: "3000", environment: { INLINE: "value" }, advanced: {} } as Service;
const deployment = { id: "d1", projectId: "p1", organizationId: "org1", environment: "production", meta: {}, envVars: { SHOULD_NOT_REPLAY: "old release" } } as Deployment;
const row = { id: "sd1", serviceId: "api", deploymentId: "d1", containerId: "old-api", ip: "172.22.0.8", allocatedResources: { containerId: "old-api", cpuCores: 1, memoryMb: 512 } } as ServiceDeployment;
const ctx = { organizationId: "org1", userId: "user1" } as never;
let runtime: DockerRuntime;
let apply: ReturnType<typeof vi.spyOn<DockerRuntime, "applyEnvironment">>;

beforeEach(async () => {
  vi.clearAllMocks();
  h.cloud.CLOUD_MODE = false;
  h.project.mockResolvedValue(project);
  h.services.mockResolvedValue([service, { ...service, id: "worker", name: "worker" }]);
  h.deployment.mockResolvedValue(deployment);
  h.rows.mockResolvedValue([row]);
  h.inFlight.mockResolvedValue([]);
  h.env.mockImplementation(async (_project, _environment, serviceId) => serviceId === null
    ? { SHARED: "new shared", OVERRIDE: "project" }
    : { TOKEN: "private saved value", OVERRIDE: "service", EMPTY: "" });
  h.liveContainer.mockResolvedValue("old-api");
  h.record.mockResolvedValue(undefined);
  h.plan.mockResolvedValue(undefined);
  h.quota.mockResolvedValue(undefined);
  h.limits.mockResolvedValue(undefined);
  runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/openship-test-absent.sock" });
  vi.spyOn(runtime, "dispose").mockResolvedValue(undefined);
  apply = vi.spyOn(runtime, "applyEnvironment").mockImplementation(async (_id, _environment, options) => {
    const result = { containerId: "new-api", ip: "172.22.0.8" };
    await options.onReplaced(result);
    return result;
  });
  h.resolveRuntime.mockResolvedValue({ runtime, serverId: "server-1" });
});
afterEach(() => vi.restoreAllMocks());

describe("apply service environment operation", () => {
  it("applies current saved layers to one live service without a deployment or build session", async () => {
    const before = Date.now();
    const result = await applyServiceEnvironment(ctx, "p1", "api");
    expect(result).toEqual({ success: true, containerId: "new-api", ip: "172.22.0.8" });
    expect(apply).toHaveBeenCalledExactlyOnceWith("old-api", {
      SHARED: "new shared", INLINE: "value", OVERRIDE: "service", TOKEN: "private saved value", EMPTY: "", PORT: "3000",
    }, expect.objectContaining({ projectId: "p1", serviceName: "api", previousIp: "172.22.0.8" }));
    expect(h.env.mock.calls).toEqual([["p1", "production", null], ["p1", "production", "api"]]);
    expect(h.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      projectId: "p1", organizationId: "org1", deploymentId: "d1", serviceId: "api",
      expectedContainerId: "old-api", previousContainerId: "old-api", containerId: "new-api",
    }));
    expect(h.record.mock.calls[0]![0].appliedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(h.record.mock.calls[0]![0].appliedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(h.createDeployment).not.toHaveBeenCalled();
    expect(h.createBuildSession).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private saved value");
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it("timestamps the captured env before a concurrent save can happen", async () => {
    const captures: Date[] = [];
    h.env.mockImplementation(async () => { captures.push(new Date()); return {}; });
    await applyServiceEnvironment(ctx, "p1", "api");
    const cutoff = h.record.mock.calls[0]![0].appliedAt as Date;
    expect(captures.every(at => at >= cutoff)).toBe(true);
  });

  it.each(["other organization", "other service", "disabled", "no container", "in flight"])("refuses %s before runtime mutation", async problem => {
    if (problem === "other organization") h.project.mockResolvedValue({ ...project, organizationId: "org2" });
    if (problem === "other service") h.services.mockResolvedValue([]);
    if (problem === "disabled") h.services.mockResolvedValue([{ ...service, enabled: false }]);
    if (problem === "no container") h.rows.mockResolvedValue([]);
    if (problem === "in flight") h.inFlight.mockResolvedValue([{ id: "building" }]);
    await expect(applyServiceEnvironment(ctx, "p1", "api")).rejects.toBeInstanceOf(Error);
    expect(h.resolveRuntime).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it("does not replace a namespace provider independently of its dependent", async () => {
    h.services.mockResolvedValue([service, { ...service, id: "worker", name: "worker", advanced: { networkMode: "service:api" } }]);
    await expect(applyServiceEnvironment(ctx, "p1", "api")).rejects.toThrow("namespace-linked");
    expect(apply).not.toHaveBeenCalled();
  });

  it("requires a complete environment before stopping anything", async () => {
    h.services.mockResolvedValue([{ ...service, environment: { REQUIRED: "${MISSING:?set it}" }, advanced: { environmentTemplateKeys: ["REQUIRED"] } }]);
    await expect(applyServiceEnvironment(ctx, "p1", "api")).rejects.toMatchObject({ code: "ENVIRONMENT_REQUIRED" });
    expect(apply).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it("keeps Cloud quota and allocation checks ahead of the runtime replacement", async () => {
    h.cloud.CLOUD_MODE = true;
    await applyServiceEnvironment(ctx, "p1", "api");
    expect(h.plan).toHaveBeenCalledExactlyOnceWith("org1");
    expect(h.quota).toHaveBeenCalledExactlyOnceWith("org1", 1, ["api"]);
    expect(h.limits).toHaveBeenCalledExactlyOnceWith("org1", runtime, [{ containerId: "old-api", allocatedResources: row.allocatedResources }]);
    expect(h.limits.mock.invocationCallOrder[0]).toBeLessThan(apply.mock.invocationCallOrder[0]!);
  });

  it("does not apply when Cloud credits or limits refuse the action", async () => {
    h.cloud.CLOUD_MODE = true;
    h.limits.mockRejectedValue(new Error("quota exceeded"));
    await expect(applyServiceEnvironment(ctx, "p1", "api")).rejects.toThrow("quota exceeded");
    expect(apply).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it("does not record success if the runtime replacement fails", async () => {
    apply.mockRejectedValue(new Error("could not start replacement"));
    await expect(applyServiceEnvironment(ctx, "p1", "api")).rejects.toThrow("could not start replacement");
    expect(h.record).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });
});
