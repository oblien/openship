/**
 * Route rules — per-project/per-route edge rules (rate-limit · ban · allow/deny)
 * for the self-hosted OpenResty guard.
 *
 * The DB `route_rule` table is the source of truth. This module serializes a
 * project's rules into the per-host shape `rules_guard.lua` expects and pushes
 * them into OpenResty's `rules` shared dict via the mgmt API — reload-free.
 * Pushes are best-effort: a failure defers to the next deploy/route reconcile,
 * which re-pushes (so a reloaded/reinstalled edge with an empty dict repopulates).
 */

import { repos } from "@repo/db";
import type { RouteRuleSpec } from "@repo/core";
import { safeErrorMessage } from "@repo/core";
import { OPENRESTY_MGMT_PORT } from "@repo/adapters";
import { postMgmtJson } from "../../lib/project-analytics";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";

/** One host's rules in the shape `rules_guard.lua` reads (longest prefix wins). */
export type HostRuleEntry = { pathPrefix: string | null; spec: RouteRuleSpec };

/**
 * Build the per-hostname ruleset for a project. A rule bound to a `domainId`
 * targets that hostname; a rule with `domainId = null` applies to every hostname
 * of the project. Disabled rules are skipped. Entries are sorted longest-prefix
 * first (deterministic; the guard also picks the longest match).
 */
export async function serializeProjectRules(
  projectId: string,
): Promise<Map<string, HostRuleEntry[]>> {
  const [rules, domains] = await Promise.all([
    repos.routeRule.listByProject(projectId),
    repos.domain.listByProject(projectId),
  ]);

  const hostById = new Map(domains.map((d) => [d.id, d.hostname.toLowerCase()]));
  const allHosts = domains.map((d) => d.hostname.toLowerCase());
  const out = new Map<string, HostRuleEntry[]>();

  const add = (host: string, entry: HostRuleEntry) => {
    const list = out.get(host);
    if (list) list.push(entry);
    else out.set(host, [entry]);
  };

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const entry: HostRuleEntry = { pathPrefix: rule.pathPrefix ?? null, spec: rule.spec };
    if (rule.domainId) {
      const host = hostById.get(rule.domainId);
      if (host) add(host, entry);
    } else {
      for (const host of allHosts) add(host, entry);
    }
  }

  for (const list of out.values()) {
    list.sort((a, b) => (b.pathPrefix?.length ?? 0) - (a.pathPrefix?.length ?? 0));
  }
  return out;
}

/** Push one host's rules to the edge (SSH tunnel for a server, loopback for local). */
async function pushHost(
  serverId: string | null,
  host: string,
  rules: HostRuleEntry[],
): Promise<void> {
  const body = { host, rules };
  if (serverId) {
    await postMgmtJson(serverId, "/rules", body);
    return;
  }
  // Local target: OpenResty's mgmt port is on this host's loopback.
  await fetch(`http://127.0.0.1:${OPENRESTY_MGMT_PORT}/rules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

/**
 * Push a project's route rules to its serving OpenResty. `priorHostnames` are
 * cleared explicitly so rules removed since the last push stop enforcing.
 * `serverId` null = local target. Best-effort per host.
 */
export async function pushProjectRules(
  projectId: string,
  serverId: string | null,
  priorHostnames: string[] = [],
): Promise<void> {
  const [map, domains] = await Promise.all([
    serializeProjectRules(projectId),
    repos.domain.listByProject(projectId),
  ]);
  // Push EVERY current hostname (empty ruleset = clear), so a deleted/disabled
  // rule stops enforcing without the caller tracking prior state. priorHostnames
  // additionally clears hosts whose domain row was removed.
  const hosts = new Set<string>([
    ...map.keys(),
    ...domains.map((d) => d.hostname.toLowerCase()),
    ...priorHostnames.map((h) => h.toLowerCase()),
  ]);
  await Promise.all(
    Array.from(hosts).map((host) =>
      pushHost(serverId, host, map.get(host) ?? []).catch((err) =>
        console.warn(`[route-rules] push failed for ${host}: ${safeErrorMessage(err)}`),
      ),
    ),
  );
}

/**
 * Resolve where a project's rules should be pushed. Returns `{ serverId }`
 * (null = local) for a self-hosted project, or `null` when it isn't applicable
 * (cloud project, or nothing to push yet). Used by the CRUD path; the route
 * reconcile path already knows the serverId and calls `pushProjectRules` directly.
 */
export async function resolveProjectPushTarget(
  projectId: string,
): Promise<{ serverId: string | null } | null> {
  const project = await repos.project.findById(projectId);
  if (!project) return null;
  if (project.cloudWorkspaceId) return null; // cloud edge is not OpenResty
  if (!project.activeDeploymentId) return { serverId: null }; // not deployed → local default
  const deployment = await repos.deployment.findById(project.activeDeploymentId);
  if (!deployment) return { serverId: null };
  const { effectiveTarget, serverId } = await resolveDeploymentRuntime(deployment);
  if (effectiveTarget === "cloud") return null;
  return { serverId: serverId ?? null };
}

/** Push after a rule mutation (resolves the target itself). Best-effort. */
export async function pushProjectRulesResolved(projectId: string): Promise<void> {
  const target = await resolveProjectPushTarget(projectId);
  if (!target) return;
  await pushProjectRules(projectId, target.serverId);
}
