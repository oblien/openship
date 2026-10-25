import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, type ClusterWorkloadStatus, type ClusterWorkloadMetrics } from "@repo/core";
import {
  createDatabase,
  createRepositories,
  schema,
  sql,
  type DatabaseConnection,
  type Repositories,
} from "@repo/db/factory";
import { createEncryption } from "../../db/src/encryption";
import type { ExecutionContext } from "../src/context";

const h = vi.hoisted(() => ({
  repos: {} as Repositories,
  cloud: false,
  status: vi.fn(),
  metrics: vi.fn(),
  scale: vi.fn(),
  runtime: vi.fn(),
  busy: false,
}));
vi.mock("@repo/db", async () => {
  const { createAdvisoryLocks } = await import("@repo/db/factory");
  return {
    repos: h.repos,
    ...createAdvisoryLocks({
      getDriver: () => "pglite",
      getPgPool: () => {
        throw new Error("No PostgreSQL in this test");
      },
    }),
  };
});
vi.mock("../src/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
    DEPLOY_MODE: "desktop",
  },
}));
vi.mock("../src/engine/lib/deployment-runtime", () => ({
  withDeploymentRuntime: (...args: unknown[]) => h.runtime(...args),
}));
vi.mock("../src/engine/lib/cloud-workspace-lock", () => ({
  withCloudWorkspaceActivity: (_id: unknown, work: () => unknown) => work(),
}));
vi.mock("../src/engine/modules/deployments/build.service", () => ({
  checkNoActiveBuild: async () => {
    if (h.busy) throw new AppError("Deployment is running", 409, "DEPLOYMENT_IN_PROGRESS");
  },
}));
vi.mock("../src/engine/modules/system/server-cluster.operations", () => ({
  assertClusterManagementAvailable: () => {
    if (h.cloud) throw new AppError("Self hosted only", 404, "CAPABILITY_UNAVAILABLE");
  },
}));

import { runAutoscaleTick } from "../src/engine/modules/projects/autoscale/autoscaler";
import { createAutoscaleOperations } from "../src/engine/modules/projects/autoscale/project-autoscale.operations";
import {
  withProjectStateLock,
  withLiveProjectRuntimeMutation,
} from "../src/engine/lib/project-runtime-lock";

const policyInput = {
  enabled: true,
  targetCpuPercent: 70,
  minReplicas: 1,
  maxReplicas: 6,
  stepSize: 1,
  cooldownSeconds: 120,
  suspendAfterFailures: 3,
};
const ctx = { organizationId: "org" } as ExecutionContext;
const operations = createAutoscaleOperations(vi.fn());
let connection: DatabaseConnection;
let status: ClusterWorkloadStatus;
let metrics: ClusterWorkloadMetrics;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const getProject = () => h.repos.project.findById("project");
const getPolicy = () => h.repos.autoscale.get("project");
async function clearBackoff() {
  await connection.db.update(schema.projectAutoscalePolicy).set({ nextAttemptAt: null });
}
async function disable() {
  return operations.setAutoscalePolicy(ctx, "project", {
    ...policyInput,
    enabled: false,
    expectedUpdatedAt: (await getPolicy())!.updatedAt.toISOString(),
  });
}

beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  Object.assign(h.repos, createRepositories(connection.db, createEncryption("autoscale-test-key")));
}, 30_000);
afterAll(async () => {
  await connection?.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  h.cloud = false;
  h.busy = false;
  await connection.db.execute(sql`TRUNCATE TABLE organization, instance_settings CASCADE`);
  const db = connection.db;
  await db.insert(schema.organization).values({ id: "org", name: "Org" });
  await db.insert(schema.computeCluster).values({
    id: "cluster",
    organizationId: "org",
    name: "Cluster",
    requestId: "request",
    inputHash: "hash",
  });
  await db.insert(schema.clusterRuntime).values({
    id: "runtime",
    clusterId: "cluster",
    organizationId: "org",
    clusterRevision: 1,
    requestId: "runtime",
    provider: "k3s",
    status: "ready",
    plan: {} as never,
  });
  await db
    .insert(schema.projectGroup)
    .values({ id: "group", organizationId: "org", name: "App", slug: "app" });
  await db.insert(schema.project).values({
    id: "project",
    groupId: "group",
    organizationId: "org",
    name: "App",
    slug: "app",
    clusterId: "cluster",
    clusterConfig: { replicas: 2 },
    resources: { production: { cpuCores: 1 } },
    activeDeploymentId: "release",
  });
  await db.insert(schema.deployment).values({
    id: "release",
    projectId: "project",
    organizationId: "org",
    branch: "main",
    status: "ready",
    containerId: "k8s:release",
    meta: { clusterId: "cluster", clusterConfig: { replicas: 2 } },
  });
  await h.repos.autoscale.save("project", policyInput);
  status = {
    desired: 2,
    ready: 2,
    available: 2,
    updated: 2,
    generation: 1,
    observedGeneration: 1,
    message: null,
    scaling: { uid: "uid", operationId: null, cpuLimitMillicores: 1000 },
    pods: ["a", "b"].map((name) => ({
      name,
      nodeName: "node",
      ready: true,
      phase: "Running",
      restarts: 0,
    })),
  };
  metrics = {
    cpuMillicores: 1800,
    memoryMiB: 100,
    pods: ["a", "b"].map((name) => ({
      name,
      cpuMillicores: 900,
      memoryMiB: 50,
      timestamp: new Date().toISOString(),
    })),
  };
  h.status.mockImplementation(async () => structuredClone(status));
  h.metrics.mockImplementation(async () => structuredClone(metrics));
  h.scale.mockImplementation(async (_ref, desired, intent) => {
    if (
      status.desired !== intent.replicas ||
      status.generation !== intent.generation ||
      status.scaling?.uid !== intent.uid
    )
      throw new AppError("Runtime changed", 409, "CLUSTER_WORKLOAD_CONFLICT");
    status.desired = desired;
    status.generation++;
    status.scaling!.operationId = intent.operationId;
  });
  h.runtime.mockImplementation(async (_deployment, work) =>
    work({ supports: () => true, status: h.status, podMetrics: h.metrics, scaleInPlace: h.scale }),
  );
});

describe("autoscaler lifecycle with real repositories and project locks", () => {
  it("commits the runtime receipt, project, snapshot and event once", async () => {
    expect((await runAutoscaleTick()).results[0].applied).toBe("scale_up");
    expect(h.scale).toHaveBeenCalledTimes(1);
    expect((await getProject())!.clusterConfig?.replicas).toBe(3);
    expect((await h.repos.deployment.findById("release"))!.meta).toMatchObject({
      clusterConfig: { replicas: 3 },
    });
    expect((await getPolicy())!.pendingScale).toBeNull();
    const [event] = await h.repos.autoscale.listEvents("project");
    expect((await getPolicy())!.lastDecision?.id).toBe(event.id);
    expect((await runAutoscaleTick()).results[0].held).toContain("rollout");
    expect(h.scale).toHaveBeenCalledTimes(1);
  });

  it.each(["cloud", "global", "disabled", "suspended"])(
    "does no Kubernetes work when %s",
    async (mode) => {
      if (mode === "cloud") h.cloud = true;
      if (mode === "global") await h.repos.instanceSettings.upsert({ autoscalerDisabled: true });
      if (mode === "disabled") await disable();
      if (mode === "suspended") await h.repos.autoscale.suspend("project", "operator override");
      await runAutoscaleTick();
      expect(h.runtime).not.toHaveBeenCalled();
    },
  );

  it("normal no-change ticks make no policy write and leave the edit revision valid", async () => {
    metrics.pods.forEach((pod) => (pod.cpuMillicores = 700));
    const policy = (await getPolicy())!;
    const success = vi.spyOn(h.repos.autoscale, "recordSuccess");
    await runAutoscaleTick();
    await runAutoscaleTick();
    expect(success).not.toHaveBeenCalled();
    expect((await getPolicy())!.updatedAt).toEqual(policy.updatedAt);
    await expect(
      operations.setAutoscalePolicy(ctx, "project", {
        ...policyInput,
        targetCpuPercent: 60,
        expectedUpdatedAt: policy.updatedAt.toISOString(),
      }),
    ).resolves.toMatchObject({ targetCpuPercent: 60 });
  });

  it.each(["missing", "partial", "old", "future", "unready"])(
    "holds on %s metrics/readiness",
    async (mode) => {
      if (mode === "missing") metrics.pods[0].cpuMillicores = null;
      if (mode === "partial") metrics.pods.pop();
      if (mode === "old") metrics.pods[0].timestamp = new Date(Date.now() - 120_000).toISOString();
      if (mode === "future")
        metrics.pods[0].timestamp = new Date(Date.now() + 120_000).toISOString();
      if (mode === "unready") status.ready = 1;
      await runAutoscaleTick();
      expect(h.scale).not.toHaveBeenCalled();
      expect((await getPolicy())!.failureCount).toBe(0);
    },
  );

  it("uses the deployed CPU limit, even when the saved project limit changed", async () => {
    status.scaling!.cpuLimitMillicores = 2000; // 45% load, not 90%
    metrics.pods.forEach((pod) => (pod.cpuMillicores = 1400)); // 70%, hold
    await runAutoscaleTick();
    expect(h.scale).not.toHaveBeenCalled();
  });

  it("does not turn normal deployment contention into failures", async () => {
    h.busy = true;
    for (let i = 0; i < 4; i++) await runAutoscaleTick();
    expect((await getPolicy())!.failureCount).toBe(0);
    expect((await getPolicy())!.suspendedAt).toBeNull();
    expect(h.runtime).not.toHaveBeenCalled();
  });

  it("rechecks the global switch after observing metrics", async () => {
    h.metrics.mockImplementationOnce(async () => {
      await h.repos.instanceSettings.upsert({ autoscalerDisabled: true });
      return metrics;
    });
    await runAutoscaleTick();
    expect(h.scale).not.toHaveBeenCalled();
  });

  it("a disable that owns the lock first prevents a queued tick", async () => {
    const entered = deferred(),
      release = deferred();
    const owner = withProjectStateLock("project", async () => {
      entered.resolve();
      await release.promise;
      await disable();
    });
    await entered.promise;
    const tick = runAutoscaleTick();
    release.resolve();
    await owner;
    await tick;
    expect(h.scale).not.toHaveBeenCalled();
  });

  it("disable waits for an admitted step, then prevents further steps", async () => {
    const entered = deferred(),
      release = deferred();
    h.metrics.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return metrics;
    });
    const tick = runAutoscaleTick();
    await entered.promise;
    let saved = false;
    const disabling = disable().then(() => {
      saved = true;
    });
    await Promise.resolve();
    expect(saved).toBe(false);
    release.resolve();
    await tick;
    await disabling;
    await runAutoscaleTick();
    expect(h.scale).toHaveBeenCalledTimes(1);
    expect((await getPolicy())!.enabled).toBe(0);
  });

  it("stop under the shared runtime lock cannot be undone by a queued tick", async () => {
    const entered = deferred(),
      release = deferred();
    const stopping = withLiveProjectRuntimeMutation("project", async () => {
      entered.resolve();
      await release.promise;
      await h.repos.project.update("project", { disabledAt: new Date() });
      status.desired = 0;
    });
    await entered.promise;
    const tick = runAutoscaleTick();
    release.resolve();
    await stopping;
    await tick;
    expect(h.scale).not.toHaveBeenCalled();
    expect(status.desired).toBe(0);
  });

  it("recovers an accepted patch after a lost response without repeating it", async () => {
    const apply = h.scale.getMockImplementation()!;
    h.scale.mockImplementationOnce(async (...args) => {
      await apply(...args);
      throw new Error("connection lost after patch");
    });
    await runAutoscaleTick();
    expect((await getProject())!.clusterConfig?.replicas).toBe(2);
    expect((await getPolicy())!.pendingScale).not.toBeNull();
    await clearBackoff();
    await runAutoscaleTick();
    expect(h.scale).toHaveBeenCalledTimes(1);
    expect((await getProject())!.clusterConfig?.replicas).toBe(3);
    expect((await getPolicy())!.pendingScale).toBeNull();
    expect(await h.repos.autoscale.listEvents("project")).toHaveLength(2);
  });

  it("retries an unapplied operation using the same identity and precondition", async () => {
    h.scale.mockRejectedValueOnce(new Error("offline before patch"));
    await runAutoscaleTick();
    const first = (await getPolicy())!.pendingScale;
    await clearBackoff();
    await runAutoscaleTick();
    expect(h.scale.mock.calls[1][2].operationId).toBe(first!.operationId);
    expect((await getProject())!.clusterConfig?.replicas).toBe(3);
  });

  it("retires an unapplied scale-up when the saved maximum is lowered", async () => {
    h.scale.mockRejectedValueOnce(new Error("offline before patch"));
    await runAutoscaleTick();
    expect((await getPolicy())!.pendingScale!.toReplicas).toBe(3);
    await operations.setAutoscalePolicy(ctx, "project", {
      ...policyInput,
      maxReplicas: 2,
      expectedUpdatedAt: (await getPolicy())!.updatedAt.toISOString(),
    });
    await clearBackoff();
    await runAutoscaleTick();
    expect(status.desired).toBe(2);
    expect((await getProject())!.clusterConfig?.replicas).toBe(2);
    expect((await getPolicy())!.pendingScale).toBeNull();
    expect(await h.repos.autoscale.lastScaleEvent("project")).toBeNull();
  });

  it("retires a stale downscale, fences its delayed request, and can scale up next", async () => {
    const apply = h.scale.getMockImplementation()!;
    metrics.pods.forEach((pod) => (pod.cpuMillicores = 100));
    h.scale.mockRejectedValueOnce(new Error("offline before patch"));
    await runAutoscaleTick();
    const stale = (await getPolicy())!.pendingScale!;
    expect(stale.toReplicas).toBe(1);
    metrics.pods.forEach((pod) => (pod.cpuMillicores = 950));
    await clearBackoff();
    await runAutoscaleTick();
    expect(status.desired).toBe(2);
    expect((await getPolicy())!.pendingScale).toBeNull();
    // A request that was delayed before the retirement can no longer land.
    await expect(apply("k8s:release", stale.toReplicas, stale)).rejects.toMatchObject({
      code: "CLUSTER_WORKLOAD_CONFLICT",
    });
    status.observedGeneration = status.generation;
    await runAutoscaleTick();
    expect(status.desired).toBe(3);
    expect((await getProject())!.clusterConfig?.replicas).toBe(3);
    expect((await h.repos.autoscale.lastScaleEvent("project"))!.action).toBe("scale_up");
  });

  it.each(["partial metrics", "stale metrics", "unready rollout", "longer cooldown"])(
    "does not replay a pending request with %s",
    async (changed) => {
      h.scale.mockRejectedValueOnce(new Error("offline before patch"));
      await runAutoscaleTick();
      if (changed === "partial metrics") metrics.pods.pop();
      if (changed === "stale metrics")
        metrics.pods[0].timestamp = new Date(Date.now() - 120_000).toISOString();
      if (changed === "unready rollout") status.ready = 1;
      if (changed === "longer cooldown") {
        await h.repos.autoscale.insertEvent("project", {
          createdAt: new Date(Date.now() - 180_000).toISOString(),
          action: "scale_up",
          fromReplicas: 1,
          toReplicas: 2,
          observedCpuPercent: 95,
          reason: "previous scale",
        });
        await operations.setAutoscalePolicy(ctx, "project", {
          ...policyInput,
          cooldownSeconds: 600,
          expectedUpdatedAt: (await getPolicy())!.updatedAt.toISOString(),
        });
      }
      await clearBackoff();
      await runAutoscaleTick();
      expect(h.scale).toHaveBeenCalledTimes(1);
      expect(status.desired).toBe(2);
      // Keep the receipt identity; an already-in-flight request may still arrive.
      expect((await getPolicy())!.pendingScale).not.toBeNull();
    },
  );

  it.each(["lost response", "failed DB clear"])(
    "recovers an accepted retirement after %s without repeating the patch",
    async (failure) => {
      const apply = h.scale.getMockImplementation()!;
      h.scale.mockRejectedValueOnce(new Error("offline before patch"));
      await runAutoscaleTick();
      metrics.pods.forEach((pod) => (pod.cpuMillicores = 700));
      if (failure === "lost response")
        h.scale.mockImplementationOnce(async (...args) => {
          await apply(...args);
          throw new Error("lost retirement response");
        });
      else
        vi.spyOn(h.repos.autoscale, "discardScale").mockRejectedValueOnce(new Error("DB offline"));
      await clearBackoff();
      await runAutoscaleTick();
      expect((await getPolicy())!.pendingScale).not.toBeNull();
      expect(status.desired).toBe(2);
      await disable();
      await runAutoscaleTick();
      expect(h.scale).toHaveBeenCalledTimes(2);
      expect((await getPolicy())!.pendingScale).toBeNull();
      expect((await getProject())!.clusterConfig?.replicas).toBe(2);
      expect(await h.repos.autoscale.lastScaleEvent("project")).toBeNull();
    },
  );

  it("reconciles the original operation if it wins the race against retirement", async () => {
    const apply = h.scale.getMockImplementation()!;
    h.scale.mockRejectedValueOnce(new Error("ambiguous request"));
    await runAutoscaleTick();
    const original = (await getPolicy())!.pendingScale!;
    metrics.pods.forEach((pod) => (pod.cpuMillicores = 700));
    h.scale.mockImplementationOnce(async (...args) => {
      // The original request arrives after observation but before cancellation.
      await apply("k8s:release", original.toReplicas, original);
      return apply(...args);
    });
    await clearBackoff();
    await runAutoscaleTick();
    expect(status.desired).toBe(3);
    expect((await getPolicy())!.pendingScale).not.toBeNull();
    await disable();
    // A receipt does not need fresh metrics or a still-enabled policy to commit.
    h.metrics.mockRejectedValue(new Error("metrics unavailable"));
    await runAutoscaleTick();
    expect((await getProject())!.clusterConfig?.replicas).toBe(3);
    expect((await getPolicy())!.pendingScale).toBeNull();
    expect(h.scale).toHaveBeenCalledTimes(2);
    expect(
      (await h.repos.autoscale.listEvents("project")).filter((e) => e.action === "scale_up"),
    ).toHaveLength(1);
  });

  it("rolls back all DB writes on commit failure, then reconciles the exact receipt", async () => {
    await connection.db.execute(
      sql`CREATE FUNCTION fail_autoscale_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; END $$`,
    );
    await connection.db.execute(
      sql`CREATE TRIGGER fail_autoscale_event BEFORE INSERT ON project_autoscale_event FOR EACH ROW EXECUTE FUNCTION fail_autoscale_event()`,
    );
    try {
      await runAutoscaleTick();
    } finally {
      await connection.db.execute(
        sql`DROP TRIGGER fail_autoscale_event ON project_autoscale_event`,
      );
      await connection.db.execute(sql`DROP FUNCTION fail_autoscale_event()`);
    }
    expect((await getProject())!.clusterConfig?.replicas).toBe(2);
    expect((await h.repos.deployment.findById("release"))!.meta).toMatchObject({
      clusterConfig: { replicas: 2 },
    });
    await clearBackoff();
    await disable();
    await runAutoscaleTick();
    expect((await getProject())!.clusterConfig?.replicas).toBe(3);
    expect(h.scale).toHaveBeenCalledTimes(1);
  });

  it("repeated patch failures back off and suspend without resetting the failure streak", async () => {
    h.scale.mockRejectedValue(new Error("cluster unavailable"));
    for (let attempt = 0; attempt < 3; attempt++) {
      await clearBackoff();
      await runAutoscaleTick();
    }
    expect((await getPolicy())!.failureCount).toBe(3);
    expect((await getPolicy())!.suspendedAt).not.toBeNull();
    await clearBackoff();
    await runAutoscaleTick();
    expect(h.scale).toHaveBeenCalledTimes(3);
  });

  it("deletion that wins admission prevents a stale tick and records no successful scale", async () => {
    const entered = deferred(),
      release = deferred();
    const deleting = withProjectStateLock("project", async () => {
      entered.resolve();
      await release.promise;
      await h.repos.project.update("project", { deletionInProgress: true });
    });
    await entered.promise;
    const tick = runAutoscaleTick();
    release.resolve();
    await deleting;
    expect((await tick).results[0].applied).toBeUndefined();
    expect(h.scale).not.toHaveBeenCalled();
    expect(await h.repos.autoscale.listEvents("project")).toHaveLength(0);
  });

  it("does not overwrite an external change between observation and apply", async () => {
    h.metrics.mockImplementationOnce(async () => {
      status.desired = 4;
      status.generation++;
      return metrics;
    });
    await runAutoscaleTick();
    await runAutoscaleTick();
    expect(status.desired).toBe(4);
    expect((await getPolicy())!.suspendedAt).not.toBeNull();
    expect((await getPolicy())!.pendingScale).toBeNull();
    expect((await getProject())!.clusterConfig?.replicas).toBe(2);
  });

  it("concurrent ticks can admit only one scale step", async () => {
    await Promise.all([runAutoscaleTick(), runAutoscaleTick()]);
    expect(h.scale).toHaveBeenCalledTimes(1);
  });

  it("refuses another tenant and a runtime without K3s support", async () => {
    const input = {
      ...policyInput,
      expectedUpdatedAt: (await getPolicy())!.updatedAt.toISOString(),
    };
    await expect(
      operations.setAutoscalePolicy(
        { organizationId: "other" } as ExecutionContext,
        "project",
        input,
      ),
    ).rejects.toThrow();
    await connection.db.update(schema.clusterRuntime).set({ provider: "swarm" });
    await expect(operations.setAutoscalePolicy(ctx, "project", input)).rejects.toMatchObject({
      code: "AUTOSCALE_POLICY_INELIGIBLE",
    });
  });

  it("hides another tenant's policy and decision trail", async () => {
    const other = { organizationId: "other" } as ExecutionContext;
    await expect(operations.getAutoscalePolicy(other, "project")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(operations.listAutoscaleEvents(other, "project")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(operations.getAutoscalePolicy(ctx, "project")).resolves.toMatchObject({
      projectId: "project",
    });
    await expect(operations.listAutoscaleEvents(ctx, "project")).resolves.toHaveProperty("events");
  });

  it("uses the longer cooldown for a DOWN decision after an UP step", async () => {
    await h.repos.autoscale.insertEvent("project", {
      createdAt: new Date(Date.now() - 180_000).toISOString(),
      action: "scale_up",
      fromReplicas: 1,
      toReplicas: 2,
      observedCpuPercent: 95,
      reason: "previous scale",
    });
    metrics.pods.forEach((pod) => (pod.cpuMillicores = 100));
    expect((await runAutoscaleTick()).results[0].held).toContain("cooling down");
    expect(h.scale).not.toHaveBeenCalled();
  });
});
