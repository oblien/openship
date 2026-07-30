/** Proves managed replicated-service scale up, zero, and restore on the lab. */
import { LocalExecutor, SwarmRuntime } from "@repo/adapters";
import type { SwarmStack } from "@repo/db";
import { createSwarmOperationsService } from "../apps/api/src/modules/swarm/swarm-operations.service";

const stackName = process.env.OPENSHIP_SWARM_MANAGED_STACK || "openship-swarm-managed-fixture";
const organizationId = "swarm-managed-proof";
const projectId = "project-managed-proof";
const source = await Bun.file(`${import.meta.dir}/../fixtures/swarm/managed-stack.yml`).text();
const runtime = await SwarmRuntime.create({ executor: new LocalExecutor(), timeoutMs: 60_000 });
const initial = await runtime.discover();

if (!initial.stacks.some((stack) => stack.name === stackName)) {
  throw new Error(`Managed proof stack ${stackName} is absent; run scripts/swarm-lab.sh managed-proof first.`);
}

const binding = {
  id: "swarm-managed-proof",
  organizationId,
  projectId,
  managerServerId: "disposable-lab-manager",
  clusterId: initial.manager.clusterId,
  stackName,
  managementMode: "managed",
  sourceKind: "inline",
  sourceStatus: "valid",
  sourceVersion: 1,
  sourceYamlEnc: source,
} as unknown as SwarmStack;

const operations = createSwarmOperationsService({
  featureEnabled: () => true,
  getStack: async () => binding,
  resolvePlatform: async () => ({ stackRuntime: runtime } as never),
  // The isolated proof has no durable stack/revision table. The real service's
  // refresh is independently covered; this invocation deliberately exercises
  // the manager-scale + convergence boundary without a second test database.
  refresh: async () => ({ status: "drifted" }),
  updateStack: async () => undefined,
  getProject: async () => undefined,
  updateDeploymentStatus: async () => undefined,
});

async function scale(replicas: number) {
  const result = await operations.scale({
    projectId,
    organizationId,
    serviceName: "web",
    replicas,
    persistence: "temporary",
  });
  if (result.state !== "ready") throw new Error(`Scale to ${replicas} did not converge: ${result.state}`);
  const snapshot = await runtime.discover();
  const service = snapshot.services.find(
    (candidate) => candidate.stackName === stackName && candidate.sourceServiceName === "web",
  );
  if (!service || service.desiredReplicas !== replicas) {
    throw new Error(`Manager did not report ${replicas} desired replicas after scale.`);
  }
  return { replicas, serviceId: service.id, desired: service.desiredReplicas };
}

const results = [await scale(2), await scale(0), await scale(1)];
const beforeRestart = (await runtime.discover()).tasks
  .filter((task) => task.serviceName === `${stackName}_web` && task.currentState.toLowerCase().startsWith("running"))
  .map((task) => task.id)
  .sort();
const restart = await operations.restart({ projectId, organizationId, serviceName: "web" });
if (restart.state !== "ready") throw new Error(`Restart did not converge: ${restart.state}`);
const afterRestart = (await runtime.discover()).tasks
  .filter((task) => task.serviceName === `${stackName}_web` && task.currentState.toLowerCase().startsWith("running"))
  .map((task) => task.id)
  .sort();
if (JSON.stringify(beforeRestart) === JSON.stringify(afterRestart)) {
  throw new Error("Force restart retained the same current task identity.");
}
const workerTask = (await runtime.discover()).tasks.find(
  (task) => task.serviceName === `${stackName}_worker` && task.currentState.toLowerCase().startsWith("running"),
);
if (!workerTask) throw new Error("Managed worker task was unavailable for the task-log proof.");
const workerLogs = await operations.logs({
  projectId,
  organizationId,
  serviceName: "worker",
  tail: 20,
  timestamps: true,
});
if (!workerLogs.entries.some((entry) => entry.message.includes("openship-swarm-worker-alive"))) {
  throw new Error("Manager service logs did not include the worker heartbeat.");
}
const taskLogs = await operations.logs({
  projectId,
  organizationId,
  serviceName: "worker",
  taskId: workerTask.id,
  tail: 20,
  timestamps: true,
});
if (!taskLogs.entries.some((entry) => entry.message.includes("openship-swarm-worker-alive"))) {
  throw new Error("Manager task-scoped logs did not include the worker heartbeat.");
}
const streamedEntries: string[] = [];
const liveLogStream = await operations.streamLogs({
  projectId,
  organizationId,
  serviceName: "worker",
  taskId: workerTask.id,
  tail: 1,
  timestamps: true,
}, (entry) => streamedEntries.push(entry.message));
await new Promise((resolve) => setTimeout(resolve, 2_500));
liveLogStream.stop();
await liveLogStream.done;
if (!streamedEntries.some((entry) => entry.includes("openship-swarm-worker-alive"))) {
  throw new Error("Manager task log follow did not receive the worker heartbeat before cancellation.");
}
const removal = await operations.remove({
  projectId,
  organizationId,
  confirmedStackName: stackName,
  expectedSourceVersion: binding.sourceVersion,
});
if (removal.state !== "removed") throw new Error(`Managed stack removal did not settle: ${removal.state}`);
const afterRemoval = await runtime.discover();
if (afterRemoval.services.some((service) => service.stackName === stackName)) {
  throw new Error("Managed stack removal left services present on the manager.");
}
if (!afterRemoval.configs.some((config) => config.name === "openship_lab_config")) {
  throw new Error("Managed stack removal deleted the external lab config.");
}
if (!afterRemoval.secrets.some((secret) => secret.name === "openship_lab_secret")) {
  throw new Error("Managed stack removal deleted the external lab secret.");
}
console.log(JSON.stringify({
  result: "managed service operations proof completed",
  stack: stackName,
  results,
  restart: { serviceId: restart.serviceId, beforeTaskIds: beforeRestart, afterTaskIds: afterRestart },
  logs: { workerEntries: workerLogs.entries.length, taskEntries: taskLogs.entries.length, streamedEntries: streamedEntries.length },
  removal,
}));
