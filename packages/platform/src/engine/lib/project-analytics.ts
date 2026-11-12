/** Resolve the domains and servers that own a project's request traffic. */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import { normalizeTrackedDomain } from "@repo/core";
import { repos, type Project } from "@repo/db";
import { isOblienBackedDeployment } from "./platform-mode";

// ─── Domain normalisation ────────────────────────────────────────────────────

/**
 * Normalize a hostname to match OpenResty's tracking key format.
 * Lua `site_logger.lua` stores counters under lowercase, no-www keys.
 */
export { normalizeTrackedDomain } from "@repo/core";

// ─── Project → domain + server resolution ────────────────────────────────────

export interface ProjectTracking {
  domain: string;
  serverId: string;
}

export type ProjectTrafficSource =
  | {
      kind: "self-hosted";
      domain: string;
      serverId: string;
      deployTarget: string | null;
    }
  | {
      kind: "cloud";
      domain: string;
      deployTarget: "cloud";
    };

async function resolveTrafficRuntime(project: Project) {
  let deployTarget: string | null = null;
  let serverId: string | null = project.serverId;

  if (project.activeDeploymentId) {
    const dep = await findActiveDeployment(project);
    const meta = dep?.meta as { deployTarget?: string; serverId?: string } | null;
    deployTarget = meta?.deployTarget ?? null;
    if (meta?.serverId) serverId = meta.serverId;
  }

  return { deployTarget: deployTarget ?? (project.workspaceId ? "cloud" : serverId ? "server" : null), serverId };
}

async function resolveProjectTrackedDomains(project: Project): Promise<string[]> {
  const rows = await repos.domain.listByProject(project.id);
  const hostnames = rows
    .map((domain) => domain.hostname)
    .filter((hostname): hostname is string => Boolean(hostname?.trim()))
    .map(normalizeTrackedDomain);

  return Array.from(new Set(hostnames));
}

/**
 * Resolve the tracked domain and server for a project.
 *
 * Domain resolution order:
 *   1. Primary domain from DB (`domain` table)
 *   2. Slug-based managed subdomain (`project.slug.baseDomain`)
 *
 * Server resolution order:
 *   1. Active deployment's `meta.serverId`
 *   2. This box's own canonical (`isLocal`) row, scoped to the project's organization
 *
 * There is no third step: a project whose org has neither is not observable from here.
 */
export async function resolveProjectTracking(projectId: string): Promise<ProjectTracking | null> {
  const source = await resolveProjectTrafficSource(projectId);
  if (!source || source.kind !== "self-hosted") {
    return null;
  }

  return { domain: source.domain, serverId: source.serverId };
}

/**
 * Map a fixed list of tracked domains to their traffic sources — the shared core
 * of the single/plural resolvers below. SaaS/OpenShip Cloud deploys observe
 * traffic at the Oblien edge; self-hosted deploys observe it via the target
 * server's OpenResty management API. Empty domain list (or no resolvable server)
 * → no sources.
 */
async function buildTrafficSourcesForDomains(
  project: Project,
  domains: string[],
): Promise<ProjectTrafficSource[]> {
  if (domains.length === 0) return [];

  let { deployTarget, serverId } = await resolveTrafficRuntime(project);

  if (isOblienBackedDeployment(deployTarget)) {
    return domains.map((domain) => ({
      kind: "cloud" as const,
      domain,
      deployTarget: "cloud" as const,
    }));
  }

  // Server: the deployment's own meta, else THIS box's canonical row — the same rule
  // `postEdgeMgmt` uses in edge-management.ts, so read and write resolve one machine.
  //
  // NOT `server.list()[0]`: that query is unscoped by organization AND by `isLocal`
  // (server.repo.ts), so it returns the oldest row in the whole instance. On a box
  // whose oldest row is a remote or foreign-org server — desktop, host-control-off,
  // or an install that added remotes before its own row existed — a derived-local
  // project (no `meta.serverId`, which is every one of them: deployment-runtime
  // records the id only for the "server" target) had its traffic read from, and its
  // tracked hostnames written to, a machine it never deployed to. `sshManager.acquire`
  // looks the id up with no organizationId, and the caller holds only `{project, read}`.
  //
  // No local row means this box is not a deploy target, so there is no edge of ours to
  // read and returning nothing is the correct answer, not a guess at another host.
  if (!serverId) {
    const local = await repos.server.findLocal(project.organizationId).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/lib/project-analytics"); return undefined; });
    serverId = local?.id ?? null;
  }
  if (!serverId) return [];

  return domains.map((domain) => ({
    kind: "self-hosted" as const,
    domain,
    serverId,
    deployTarget,
  }));
}

/**
 * Resolve where request traffic is observed for ONE of the project's domains: a
 * validated `domain` override (route switch), else the primary tracked route.
 */
export async function resolveProjectTrafficSource(
  projectId: string,
  opts?: {
    /** Restrict traffic to ONE of the project's domains (route switch). Validated
     *  against the project's tracked domains — an unknown value is ignored and we
     *  fall back to the primary, so a client can never fetch logs for an arbitrary
     *  (cross-tenant) host. */
    domain?: string;
  },
): Promise<ProjectTrafficSource | null> {
  const project = await repos.project.findById(projectId);
  if (!project) return null;

  // Domain: a validated override (route switch), else the primary tracked route.
  let domain: string | null = null;
  const requested = opts?.domain?.trim();
  if (requested) {
    const normalized = normalizeTrackedDomain(requested);
    const tracked = (await resolveProjectTrackedDomains(project)).map(normalizeTrackedDomain);
    if (tracked.includes(normalized)) domain = normalized;
  }
  if (!domain) {
    const primaryDomain = await repos.domain.getPrimaryByProject(projectId);
    domain = primaryDomain?.hostname ? normalizeTrackedDomain(primaryDomain.hostname) : null;
  }
  if (!domain) return null;

  const [source] = await buildTrafficSourcesForDomains(project, [domain]);
  return source ?? null;
}

/**
 * Resolve all domains that should contribute to project-level overview analytics.
 * Normal apps usually have one domain; compose/service apps can have one domain
 * per exposed service, so the overview aggregates them.
 */
export async function resolveProjectTrafficSources(
  projectId: string,
  opts?: {
    /** Scope to ONE tracked domain (route switch). Validated + primary fallback,
     *  identical to resolveProjectTrafficSource, returned as a one-element array.
     *  Omit to aggregate every tracked domain. */
    domain?: string;
  },
): Promise<ProjectTrafficSource[]> {
  if (opts?.domain) {
    const source = await resolveProjectTrafficSource(projectId, { domain: opts.domain });
    return source ? [source] : [];
  }

  const project = await repos.project.findById(projectId);
  if (!project) return [];

  const domains = await resolveProjectTrackedDomains(project);
  return buildTrafficSourcesForDomains(project, domains);
}
