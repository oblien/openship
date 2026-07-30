/** Safe retention cleanup for immutable OpenShip-managed Swarm resources. */

import { sq, type SwarmDiscoverySnapshot } from "@repo/adapters";
import { repos, type SwarmStack, type SwarmStackRevision } from "@repo/db";
import { resolveTargetPlatform } from "../../../lib/deployment-runtime";
import { MANAGED_RESOURCE_CREATED_AT_LABEL } from "../../swarm/swarm-managed-resources";

export const SWARM_MANAGED_RESOURCE_GRACE_MS = 24 * 60 * 60 * 1000;

type ManagedResourceKind = "config" | "secret";

type ManagedResource = {
  name: string;
  labels: Record<string, string>;
  createdAt: string | null;
};

export interface SwarmResourceGcPlan {
  configs: string[];
  secrets: string[];
}

export interface SwarmResourceGcSweepSummary {
  stacksScanned: number;
  configsRemoved: number;
  secretsRemoved: number;
  errors: number;
}

function isManagedForProject(resource: ManagedResource, projectId: string): boolean {
  return resource.labels["com.openship.swarm.managed-resource"] === "true" &&
    resource.labels["com.openship.swarm.project-id"] === projectId;
}

function olderThanGrace(createdAt: string | null, now: Date, graceMs: number): boolean {
  if (!createdAt) return false;
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && created <= now.getTime() - graceMs;
}

/**
 * Only ready, active, or in-flight revisions protect resource refs. Retention
 * pruning removes expired ready revisions first; failed pre-apply attempts can
 * therefore age out after the grace period without risking a live stack.
 */
export function retainedSwarmResourceRefs(
  revisions: SwarmStackRevision[],
  lastAppliedRevisionId: string | null,
): { configs: Set<string>; secrets: Set<string> } {
  const configs = new Set<string>();
  const secrets = new Set<string>();
  for (const revision of revisions) {
    const retained = revision.id === lastAppliedRevisionId ||
      revision.applyStatus === "ready" ||
      revision.applyStatus === "applying" ||
      revision.applyStatus === "converging";
    if (!retained) continue;
    for (const name of revision.configRefs) configs.add(name);
    for (const name of revision.secretRefs) secrets.add(name);
  }
  return { configs, secrets };
}

/** Pure candidate selection: external/foreign resources and young objects stay untouched. */
export function planSwarmManagedResourceGc(input: {
  projectId: string;
  discovery: Pick<SwarmDiscoverySnapshot, "configs" | "secrets">;
  protectedRefs: { configs: Set<string>; secrets: Set<string> };
  now: Date;
  graceMs?: number;
}): SwarmResourceGcPlan {
  const graceMs = input.graceMs ?? SWARM_MANAGED_RESOURCE_GRACE_MS;
  const candidates = (kind: ManagedResourceKind, resources: ManagedResource[], protectedNames: Set<string>) =>
    resources
      .filter((resource) => isManagedForProject(resource, input.projectId))
      .filter((resource) => !protectedNames.has(resource.name))
      .filter((resource) => olderThanGrace(resource.labels[MANAGED_RESOURCE_CREATED_AT_LABEL] ?? resource.createdAt, input.now, graceMs))
      .map((resource) => resource.name)
      .sort();
  return {
    configs: candidates("config", input.discovery.configs, input.protectedRefs.configs),
    secrets: candidates("secret", input.discovery.secrets, input.protectedRefs.secrets),
  };
}

/**
 * Best-effort post-retention cleanup. Docker discovery lists only named-object
 * metadata, and deletion is restricted to an OpenShip label plus project ID.
 * It deliberately does not use secret inspect or payload-export commands.
 */
export async function reapExpiredSwarmManagedResources(input: {
  stack: Pick<SwarmStack, "id" | "projectId" | "organizationId" | "managerServerId" | "lastAppliedRevisionId">;
  now?: Date;
}): Promise<SwarmResourceGcPlan> {
  if (!input.stack.managerServerId) return { configs: [], secrets: [] };
  const platform = await resolveTargetPlatform(
    "server",
    "docker",
    input.stack.managerServerId,
    input.stack.organizationId,
    "swarm",
  );
  if (!platform.stackRuntime || !platform.executor) return { configs: [], secrets: [] };
  const [discovery, revisions] = await Promise.all([
    platform.stackRuntime.discover(),
    repos.swarmStack.listRevisionsInOrganization(input.stack.id, input.stack.organizationId),
  ]);
  const plan = planSwarmManagedResourceGc({
    projectId: input.stack.projectId,
    discovery,
    protectedRefs: retainedSwarmResourceRefs(revisions, input.stack.lastAppliedRevisionId),
    now: input.now ?? new Date(),
  });
  for (const name of plan.configs) {
    await platform.executor.exec(`docker config rm ${sq(name)}`).catch(() => undefined);
  }
  for (const name of plan.secrets) {
    await platform.executor.exec(`docker secret rm ${sq(name)}`).catch(() => undefined);
  }
  return plan;
}

/** Daily backstop for grace-qualified objects left by failed or superseded applies. */
export async function runSwarmManagedResourceGcSweep(loaders: {
  listManaged?: typeof repos.swarmStack.listManaged;
  reap?: typeof reapExpiredSwarmManagedResources;
} = {}): Promise<SwarmResourceGcSweepSummary> {
  const listManaged = loaders.listManaged ?? (() => repos.swarmStack.listManaged());
  const reap = loaders.reap ?? reapExpiredSwarmManagedResources;
  const summary: SwarmResourceGcSweepSummary = {
    stacksScanned: 0,
    configsRemoved: 0,
    secretsRemoved: 0,
    errors: 0,
  };
  for (const stack of await listManaged()) {
    summary.stacksScanned += 1;
    try {
      const result = await reap({ stack });
      summary.configsRemoved += result.configs.length;
      summary.secretsRemoved += result.secrets.length;
    } catch (error) {
      summary.errors += 1;
      console.error(`[swarm-resource-gc] stack ${stack.id} skipped:`, error);
    }
  }
  return summary;
}
