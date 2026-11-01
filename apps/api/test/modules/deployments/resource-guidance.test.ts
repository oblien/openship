import { expect, it } from "vitest";
import { AppError, DEPLOYMENT_RESOURCE_FAILURE_CODE, type LogEntry } from "@repo/core";
import { BuildLogger, type RuntimeAdapter } from "@repo/adapters";
import { db, repos, schema } from "@repo/db";
import {
  onFailure,
  onSuccess,
} from "@repo/platform/engine/modules/deployments/deployment-lifecycle";
import { getBuildSessionStatus } from "@repo/platform/engine/modules/deployments/build-status.service";
import { deploymentResourceFailure } from "@repo/platform/engine/modules/deployments/resource-failure";
import { verifyDeployedContainers } from "@repo/platform/engine/modules/deployments/stability-audit.service";
import { collapseTerminalLogs } from "@repo/platform/engine/modules/deployments/terminal-logs";
import { sanitizeLogsForPersistence } from "@repo/platform/engine/modules/deployments/build-log-sanitize";
import { seedOrg, seedProject, seedDeployment } from "../../helpers/seed";

async function attempt(cloud = true) {
  const owner = await seedOrg();
  let serverId: string | null = null;
  if (cloud) {
    const workspaceId = `space-${owner.organizationId}`;
    await db
      .insert(schema.cloudWorkspace)
      .values({ id: workspaceId, organizationId: owner.organizationId, name: "Production" });
    serverId = (
      await repos.server.create({
        organizationId: owner.organizationId,
        workspaceId,
        sshHost: null,
      })
    ).id;
  }
  const project = await seedProject(owner.organizationId, { serverId });
  const dep = await seedDeployment(project, {
    status: "deploying",
    meta: { runtimeMode: "docker", deployTarget: cloud ? "cloud" : "local" },
  });
  const session = await repos.deployment.createBuildSession({
    deploymentId: dep.id,
    projectId: project.id,
    status: "deploying",
  });
  const logs: LogEntry[] = [];
  const resourceEvidence: LogEntry[] = [];
  const logger = new BuildLogger((entry) => {
    logs.push(entry);
    if (entry.resourceIssue) resourceEvidence.push(entry);
  });
  return {
    project,
    dep,
    buildSessionId: session.id,
    persistLogs: () => sanitizeLogsForPersistence(collapseTerminalLogs(logs)),
    logs,
    resourceEvidence,
    logger,
    provisioned: {},
  };
}

it("persists the diagnosis with failure and restores it without an active stream", async () => {
  const ctx = await attempt();
  await onFailure(ctx, "npm ERR! code ENOMEM", 1234);
  expect(await repos.deployment.findById(ctx.dep.id)).toMatchObject({
    status: "failed",
    buildDurationMs: 1234,
    errorCode: DEPLOYMENT_RESOURCE_FAILURE_CODE,
    errorDetails: {
      resourceIssue: "memory-allocation",
      workspaceId: ctx.project.workspaceId,
      projectId: ctx.project.id,
    },
  });
  // The DB-backed reload restores the attempt's saved binding.
  expect(await getBuildSessionStatus(ctx.dep.id)).toMatchObject({
    status: "failed",
    errorDetails: { resourceIssue: "memory-allocation", workspaceId: ctx.project.workspaceId },
  });
});

it("retains authoritative container OOM evidence even when no terminal logs can be retained", async () => {
  const ctx = await attempt();
  const runtime = {
    supports: (cap: string) => cap === "stabilityProbe",
    sampleStability: async () => ({
      state: "exited",
      exitCode: 137,
      restartCount: 0,
      health: null,
      errorLine: null,
      oomKilled: true,
      restartPolicy: "no",
    }),
    getRuntimeLogs: async () => [],
  } as unknown as RuntimeAdapter;
  const [finding] = await verifyDeployedContainers(
    runtime,
    [{ serviceId: "api", serviceName: "api", containerId: "this-attempt" }],
    ctx.logger,
    { windowMs: 10, pollMs: 1 },
  );
  ctx.persistLogs = () => [];
  await onFailure(ctx, finding!.detail);
  expect((await repos.deployment.findById(ctx.dep.id))?.errorDetails).toMatchObject({
    resourceIssue: "container-oom",
  });
});

it("keeps an unrelated OOM out of another failing service's diagnosis", async () => {
  const ctx = await attempt();
  ctx.logs.push({
    timestamp: new Date().toISOString(),
    message: "other-service ran out of memory",
    level: "error",
    resourceIssue: "container-oom",
    serviceName: "other",
  });
  ctx.resourceEvidence.push(ctx.logs[0]!);
  await onFailure(ctx, "api: failed to reach its database");
  expect((await repos.deployment.findById(ctx.dep.id))?.errorDetails).toBeNull();
});

it.each(["PORT_IN_USE", "HOST_UNREACHABLE", "CLOUD_CAPACITY_UNAVAILABLE"])(
  "preserves %s recovery instead of presenting an upgrade",
  async (errorCode) => {
    const ctx = await attempt();
    const meta = { errorCode, errorDetails: { port: 3000 } };
    await onFailure(ctx, "ENOMEM was mentioned by the remote diagnostic", 1, meta);
    expect(await repos.deployment.findById(ctx.dep.id)).toMatchObject(meta);
  },
);

it("keeps measured storage preflight evidence through adapter causes", async () => {
  const ctx = await attempt();
  const cause = new Error("build failed", {
    cause: new AppError("Storage reserve exhausted", 409, "BUILD_STORAGE_LOW"),
  });
  const meta = deploymentResourceFailure({
    project: ctx.project,
    message: cause.message,
    causes: [new Error("An unrelated service build failed"), cause],
  });
  await onFailure(ctx, cause.message, 1, meta);
  expect(await getBuildSessionStatus(ctx.dep.id)).toMatchObject({
    errorCode: "BUILD_STORAGE_LOW",
    errorDetails: { resourceIssue: "storage-low" },
  });
});

it("keeps self-hosted failures free of Cloud upgrade metadata", async () => {
  const ctx = await attempt(false);
  await onFailure(ctx, "npm ERR! code ENOSPC");
  expect(await repos.deployment.findById(ctx.dep.id)).toMatchObject({
    errorCode: null,
    errorDetails: null,
  });
});

it.each(["OBLIEN_REQUEST_FAILED", "ENOMEM", "ENOSPC"])(
  "does not attribute controller/provider %s to the customer's capacity",
  async (code) => {
    const ctx = await attempt();
    const cause = Object.assign(new Error("Controller/provider diagnostics mention ENOSPC"), {
      code,
    });
    const meta = deploymentResourceFailure({ project: ctx.project, message: cause.message, cause });
    await onFailure(ctx, cause.message, 1, meta);
    expect(await repos.deployment.findById(ctx.dep.id)).toMatchObject({
      errorCode: code,
      errorDetails: null,
    });
  },
);

it("cannot replace an already cancelled outcome with resource guidance", async () => {
  const ctx = await attempt();
  await repos.deployment.updateStatus(ctx.dep.id, "cancelled");
  await onFailure(ctx, "process exited with code 137");
  expect(await repos.deployment.findById(ctx.dep.id)).toMatchObject({
    status: "cancelled",
    errorCode: null,
    errorDetails: null,
  });
});

it("retains resource guidance for a published partial rollout without turning it into failure", async () => {
  const ctx = await attempt();
  const failureMeta = deploymentResourceFailure({
    project: ctx.project,
    message: "api: no space left on device",
  });
  await onSuccess(ctx, {
    containerId: "compose",
    durationMs: 100,
    decisionPending: true,
    warningMessage: "api failed; database kept running",
    failureMeta,
    metaPatch: {
      composeDeployment: {
        totalServices: 2,
        successfulServices: 1,
        failedServices: 1,
        decision: "pending",
      },
    },
  });
  expect(await getBuildSessionStatus(ctx.dep.id)).toMatchObject({
    status: "ready",
    decisionPending: true,
    errorDetails: { resourceIssue: "storage-full" },
  });
});
