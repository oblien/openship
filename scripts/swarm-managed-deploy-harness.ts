/**
 * Runs the managed-stack deployment service against the disposable nested
 * Swarm manager. Persistence is in-memory; Docker calls are real. It proves
 * the stack-level runtime reference, service refs, first-claim labels, and a
 * same-source redeploy that does not recreate tasks.
 */
import { LocalExecutor, SwarmRuntime, type StackRuntimeAdapter } from "@repo/adapters";
import type { Deployment, Project, Service, SwarmStack, SwarmStackRevision } from "@repo/db";
import {
  createSwarmDeployService,
  type SwarmDeployLogger,
} from "../apps/api/src/modules/deployments/swarm/deploy.service";
import { createSwarmDeploymentReconciler } from "../apps/api/src/modules/deployments/swarm/reconcile.service";
import { swarmLiveStateDigest } from "../apps/api/src/modules/swarm/swarm-preview";

const stackName = process.env.OPENSHIP_SWARM_MANAGED_STACK || "openship-swarm-managed-fixture";
const organizationId = "swarm-managed-proof";
const projectId = "project-managed-proof";
const serverId = "disposable-lab-manager";
const source = await Bun.file(`${import.meta.dir}/../fixtures/swarm/managed-stack.yml`).text();
const now = new Date("2026-07-30T00:00:00.000Z");
const runtime = await SwarmRuntime.create({ executor: new LocalExecutor(), timeoutMs: 60_000 });
const initial = await runtime.discover();

if (initial.stacks.some((stack) => stack.name === stackName)) {
  throw new Error(
    `Managed proof stack ${stackName} already exists; run scripts/swarm-lab.sh cleanup first.`,
  );
}

let binding = {
  id: "swarm-managed-proof",
  organizationId,
  projectId,
  managerServerId: serverId,
  clusterId: initial.manager.clusterId,
  stackName,
  managementMode: "observe",
  sourceKind: "inline",
  sourceStatus: "valid",
  sourcePaths: [],
  sourcePath: null,
  sourceBranch: null,
  sourceCommitSha: null,
  sourceVersion: 1,
  sourceYamlEnc: source,
  sourceDigest: "sha256:managed-proof-source",
  routingMode: "external",
  registryId: null,
  prune: false,
  resolveImage: "always",
  withRegistryAuth: false,
  lastObservedDigest: null,
  lastAppliedRevisionId: null,
  driftStatus: "clean",
  driftDetails: { claimLiveDigest: swarmLiveStateDigest([]) },
  observedState: {},
  lastObservedAt: null,
  claimedAt: now,
  createdAt: now,
  updatedAt: now,
} as unknown as SwarmStack;

const revisions: SwarmStackRevision[] = [];
const serviceDeployments: Array<Record<string, unknown>> = [];
const serviceRows = new Map<string, Service>();
let revisionNumber = 0;
const deployLogLines: string[] = [];
const logger: SwarmDeployLogger = {
  // Docker's --detach=false progress redraw is intentionally retained in the
  // revision and build-session model; do not flood this disposable proof's
  // stdout with thousands of redraw fragments.
  log: (message) => {
    if (deployLogLines.length < 20) deployLogLines.push(message.trim());
  },
  step: (phase, state, message) =>
    process.stdout.write(`[swarm-managed] ${phase}:${state} ${message}\n`),
};

const deploy = createSwarmDeployService({
  featureEnabled: () => true,
  getStack: async () => binding,
  resolvePlatform: async () => ({ stackRuntime: runtime }) as never,
  createRevision: async (_stackId, _organizationId, data) => {
    const revision = {
      ...data,
      id: `revision-${++revisionNumber}`,
      stackId: binding.id,
      revision: revisionNumber,
    } as SwarmStackRevision;
    revisions.push(revision);
    return revision;
  },
  updateRevision: async (id, _organizationId, patch) => {
    const revision = revisions.find((candidate) => candidate.id === id);
    if (!revision) return undefined;
    Object.assign(revision, patch);
    return revision;
  },
  updateStack: async (_id, _organizationId, patch) => {
    Object.assign(binding, patch);
    return binding;
  },
  syncProjections: async (_projectId, projections) =>
    projections.map((projection, index) => {
      const existing = serviceRows.get(projection.sourceServiceName);
      const row =
        existing ??
        ({
          id: `service-${index + 1}`,
          projectId,
          name: projection.sourceServiceName,
          sourceServiceName: projection.sourceServiceName,
        } as Service);
      serviceRows.set(projection.sourceServiceName, row);
      return row;
    }),
  createServiceDeployments: async (rows) => {
    serviceDeployments.push(...rows);
    return [] as never;
  },
  now: () => new Date(),
});

const project = { id: projectId, organizationId } as Project;
const firstDeployment = {
  id: "deployment-managed-1",
  organizationId,
  createdAt: now,
} as Deployment;
const first = await deploy.deploy({
  project,
  deployment: firstDeployment,
  environment: {},
  logger,
});
if (first.state !== "ready" || binding.managementMode !== "managed") {
  throw new Error(
    `Expected first managed apply to converge and establish labels; state=${first.state} mode=${binding.managementMode}`,
  );
}
if (
  serviceDeployments.length !== 2 ||
  revisions.length !== 1 ||
  first.runtimeRef.kind !== "swarm-stack"
) {
  throw new Error(
    "Managed apply did not create the expected revision, stack reference, and two service deployment rows.",
  );
}
const afterFirst = await runtime.discover();
const firstTaskIds = afterFirst.tasks
  .filter((task) => ["web", "worker"].some((name) => task.serviceName === `${stackName}_${name}`))
  .map((task) => task.id)
  .sort();
if (firstTaskIds.length !== 2)
  throw new Error("Managed fixture did not expose two current service tasks after apply.");

const secondDeployment = {
  id: "deployment-managed-2",
  organizationId,
  createdAt: now,
} as Deployment;
const second = await deploy.deploy({
  project,
  deployment: secondDeployment,
  environment: {},
  logger,
});
const afterSecond = await runtime.discover();
const secondTaskIds = afterSecond.tasks
  .filter((task) => ["web", "worker"].some((name) => task.serviceName === `${stackName}_${name}`))
  .map((task) => task.id)
  .sort();
if (second.state !== "ready" || JSON.stringify(firstTaskIds) !== JSON.stringify(secondTaskIds)) {
  throw new Error("Same-source managed redeploy unexpectedly changed the fixture's running tasks.");
}

// Simulate the failure mode that matters operationally: Docker accepted the
// third apply, but the caller lost the command response. The adapter still
// performs the real operation on the disposable manager; only the response is
// withheld. Recovery must only observe state and must not submit a fourth apply.
const responseLostRuntime: StackRuntimeAdapter = {
  name: "swarm",
  probe: () => runtime.probe(),
  discover: () => runtime.discover(),
  renderStack: (input) => runtime.renderStack(input),
  deployStack: async (input) => {
    await runtime.deployStack(input);
    throw new Error("connection lost after manager accepted stack deploy");
  },
  scaleService: (input) => runtime.scaleService(input),
  restartService: (input) => runtime.restartService(input),
  getServiceLogs: (input) => runtime.getServiceLogs(input),
  streamServiceLogs: (input, onEntry) => runtime.streamServiceLogs(input, onEntry),
  removeStack: (input) => runtime.removeStack(input),
};
const responseLostDeploy = createSwarmDeployService({
  featureEnabled: () => true,
  getStack: async () => binding,
  resolvePlatform: async () => ({ stackRuntime: responseLostRuntime }) as never,
  createRevision: async (_stackId, _organizationId, data) => {
    const revision = {
      ...data,
      id: `revision-${++revisionNumber}`,
      stackId: binding.id,
      revision: revisionNumber,
    } as SwarmStackRevision;
    revisions.push(revision);
    return revision;
  },
  updateRevision: async (id, _organizationId, patch) => {
    const revision = revisions.find((candidate) => candidate.id === id);
    if (!revision) return undefined;
    Object.assign(revision, patch);
    return revision;
  },
  updateStack: async (_id, _organizationId, patch) => {
    Object.assign(binding, patch);
    return binding;
  },
  syncProjections: async (_projectId, projections) =>
    projections.map((projection, index) => {
      const existing = serviceRows.get(projection.sourceServiceName);
      const row =
        existing ??
        ({
          id: `service-${index + 1}`,
          projectId,
          name: projection.sourceServiceName,
          sourceServiceName: projection.sourceServiceName,
        } as Service);
      serviceRows.set(projection.sourceServiceName, row);
      return row;
    }),
  createServiceDeployments: async (rows) => {
    serviceDeployments.push(...rows);
    return [] as never;
  },
  now: () => new Date(),
});
const lostResponseDeployment = {
  id: "deployment-managed-lost-response",
  organizationId,
  createdAt: now,
  meta: {},
} as Deployment;
const uncertain = await responseLostDeploy.deploy({
  project,
  deployment: lostResponseDeployment,
  environment: {},
  logger,
});
if (uncertain.state !== "reconciling") {
  throw new Error(
    `Expected a lost Docker command response to be reconciling, received ${uncertain.state}.`,
  );
}
const settledStatuses = new Map<string, string>();
const reconciler = createSwarmDeploymentReconciler({
  getStack: async () => binding,
  getRevision: async (id) => revisions.find((revision) => revision.id === id),
  resolvePlatform: async () => ({ stackRuntime: runtime }) as never,
  updateRevision: async (id, _organizationId, patch) => {
    const revision = revisions.find((candidate) => candidate.id === id);
    if (!revision) return undefined;
    Object.assign(revision, patch);
    return revision;
  },
  updateStack: async (_id, _organizationId, patch) => {
    Object.assign(binding, patch);
    return binding;
  },
  syncProjections: async (_projectId, projections) =>
    projections.map((projection, index) => {
      const existing = serviceRows.get(projection.sourceServiceName);
      const row =
        existing ??
        ({ id: `service-${index + 1}`, projectId, name: projection.sourceServiceName } as Service);
      serviceRows.set(projection.sourceServiceName, row);
      return row;
    }),
  listServiceDeployments: async () => [],
  updateServiceDeployment: async () => undefined,
  createServiceDeployments: async (rows) => {
    serviceDeployments.push(...rows);
    return [] as never;
  },
  updateDeployment: async (id, status) => {
    settledStatuses.set(id, status);
  },
  getProject: async () => ({ id: projectId, activeDeploymentId: null }) as Project,
  getDeployment: async () => undefined,
  setActiveDeployment: async () => undefined,
  now: () => new Date(),
});
const reconcileOutcome = await reconciler.reconcile({
  deployment: lostResponseDeployment,
  runtimeRef: uncertain.runtimeRef as Extract<typeof uncertain.runtimeRef, { kind: "swarm-stack" }>,
});
if (
  reconcileOutcome !== "finalized" ||
  settledStatuses.get(lostResponseDeployment.id) !== "ready"
) {
  throw new Error(
    `Lost-response reconciliation did not settle safely: outcome=${reconcileOutcome} status=${settledStatuses.get(lostResponseDeployment.id)} details=${JSON.stringify(binding.driftDetails)}`,
  );
}
const afterRecovery = await runtime.discover();
const recoveredTaskIds = afterRecovery.tasks
  .filter((task) => ["web", "worker"].some((name) => task.serviceName === `${stackName}_${name}`))
  .map((task) => task.id)
  .sort();
if (JSON.stringify(secondTaskIds) !== JSON.stringify(recoveredTaskIds)) {
  throw new Error(
    "Lost-response reconciliation changed live task identities instead of only observing the accepted apply.",
  );
}

console.log(
  JSON.stringify({
    result: "managed deploy proof completed",
    stack: stackName,
    deployments: [firstDeployment.id, secondDeployment.id, lostResponseDeployment.id],
    revisions: revisions.map((revision) => ({
      id: revision.id,
      status: revision.applyStatus,
      digest: revision.renderedDigest,
    })),
    serviceDeployments: serviceDeployments.map((row) => ({
      serviceName: row.serviceName,
      runtimeRef: row.runtimeRef,
    })),
    deployLogLines,
    taskIds: secondTaskIds,
    lostResponseRecovery: {
      outcome: reconcileOutcome,
      status: settledStatuses.get(lostResponseDeployment.id),
    },
  }),
);
