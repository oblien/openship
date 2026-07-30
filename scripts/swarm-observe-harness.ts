/**
 * Runs the observe-only application services against the disposable nested
 * Swarm manager. Durable writes are replaced with in-memory records so this
 * verifies the Docker boundary, not a developer's local database.
 *
 * The shell wrapper captures Docker events around this program and fails if a
 * workload mutation occurs. Do not run it against a non-disposable manager.
 */
import { LocalExecutor, SwarmRuntime } from "@repo/adapters";
import type { SwarmStack } from "@repo/db";
import { createSwarmObserveService } from "../apps/api/src/modules/swarm/swarm-observe.service";
import { createSwarmObservationService } from "../apps/api/src/modules/swarm/swarm-observation.service";
import { validateStackSource } from "../apps/api/src/modules/swarm/swarm-source.model";

const stackName = process.env.OPENSHIP_SWARM_FIXTURE_STACK || "openship-swarm-fixture";
const organizationId = "swarm-observe-proof";
const serverId = "disposable-lab-manager";
const now = new Date("2026-07-30T00:00:00.000Z");

let binding: SwarmStack | undefined;
const runtime = await SwarmRuntime.create({ executor: new LocalExecutor(), timeoutMs: 15_000 });

// Probe and discovery are repeated intentionally: reconnect/polling must be
// just as inert as a first read.
await runtime.probe();
await runtime.discover();
await runtime.probe();
const discovery = await runtime.discover();

if (!discovery.stacks.some((stack) => stack.name === stackName)) {
  throw new Error(`Disposable fixture stack ${stackName} was not found on the configured manager.`);
}

const platform = { stackRuntime: runtime } as never;
const observe = createSwarmObserveService({
  featureEnabled: () => true,
  resolvePlatform: async () => platform,
  findStack: async () => binding,
  createGroup: async () => ({ id: "group-observe-proof" }),
  createProject: async () => ({ id: "project-observe-proof" }),
  createStack: async (input) => {
    binding = {
      ...input,
      id: "stack-observe-proof",
      routingMode: "external",
      prune: false,
      resolveImage: "changed",
      withRegistryAuth: false,
      sourceVersion: 1,
      registryId: null,
      lastAppliedRevisionId: null,
      claimedAt: null,
      driftStatus: "unknown",
      driftDetails: {},
      createdAt: now,
      updatedAt: now,
    } as unknown as SwarmStack;
    return binding;
  },
  syncProjections: async () => [],
  now: () => now,
});

const imported = await observe.observe({ serverId, organizationId, stackName });
if (!imported.created || !binding) {
  throw new Error("Expected the disposable stack to create a new observe binding.");
}

// A second import proves the normal polling/reconnect path is idempotent and
// still only re-discovers manager truth.
const repeated = await observe.observe({ serverId, organizationId, stackName });
if (repeated.created) throw new Error("Repeated observe unexpectedly created another binding.");

const observation = createSwarmObservationService({
  featureEnabled: () => true,
  getStack: async () => binding,
  resolvePlatform: async () => platform,
  updateStack: async (_id, _organizationId, patch) => {
    Object.assign(binding!, patch);
    return binding;
  },
  syncProjections: async () => [],
  now: () => now,
});

await observation.refresh(imported.projectId, organizationId);
await observation.refresh(imported.projectId, organizationId);

// This is the same Docker-native config path used to validate an authoritative
// inline source. It stages only under /tmp and never invokes stack deploy.
const source = "services:\n  web:\n    image: nginx:1.27-alpine\n";
validateStackSource({ kind: "inline", yaml: source, expectedVersion: 1 });
const rendered = await runtime.renderStack({
  files: [{ path: "compose.yaml", content: source }],
  composePaths: ["compose.yaml"],
  ownershipLabels: { web: { "com.openship.swarm.observe-proof": "true" } },
});

console.log(JSON.stringify({
  result: "observe-only proof completed",
  stack: stackName,
  operations: ["probe", "discover", "observe", "observe-idempotent", "refresh", "refresh", "source-validate", "render"],
  renderedDigest: rendered.renderedDigest,
}));
