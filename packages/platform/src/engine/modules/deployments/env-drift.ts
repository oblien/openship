/**
 * Env drift — "has this project's env changed since what is actually running?"
 *
 * ONE anchor, two questions. Both the smart-redeploy router (which services need
 * an env-only refresh) and the service restart guard (is a bounce about to lie to
 * the operator) have to agree on when a variable counts as newer than the running
 * container. They used to be one private function here and nothing there, so the
 * restart path had no answer at all — a `docker restart` reported success having
 * applied nothing, which is GH-615.
 *
 * Anchor: the ACTIVE deployment's `createdAt`, advanced for one service by a
 * successful runtime-only environment apply. Applying one service must not
 * clear another service's pending project-level changes.
 *
 * Values are never read here, only `updatedAt` and the key NAME, so no
 * decryption is involved and a key is safe to name in an API response.
 */

import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import { repos, type Project } from "@repo/db";
import { OperationError } from "@repo/contracts";

/**
 * A restart cannot apply this service's pending env — Docker fixes a container's
 * environment at creation time, so bouncing it re-runs the OLD config.
 *
 * 409 rather than 400: the request is well-formed and the caller is allowed to
 * make it; the RESOURCE is in a state where the action would be a silent no-op.
 * The code lets a client branch on it, and `staleEnvKeys` names what is pending
 * so the operator can see the refusal is about the change they just made.
 */
export class ServiceConfigStaleError extends OperationError {
  constructor(
    message: string,
    readonly staleEnvKeys: string[],
    readonly serviceName: string,
  ) {
    super(message, 409, "SERVICE_CONFIG_STALE", { success: false, staleEnvKeys, serviceName });
    this.name = "ServiceConfigStaleError";
  }
}

/** The cutoff every drift question is asked against, or null when there is
 *  nothing deployed to compare with (first deploy → forceAll handles it). */
async function envDriftAnchors(project: Project) {
  if (!project.activeDeploymentId) return null;
  const active = await findActiveDeployment(project).catch(() => null);
  if (!active?.createdAt) return null;
  const applied = (active.meta as {
    serviceEnvironmentApplied?: Record<string, { appliedAt?: string }>;
  } | null)?.serviceEnvironmentApplied;
  return (serviceId: string): Date => {
    const cutoff = Date.parse(applied?.[serviceId]?.appliedAt ?? "");
    return Number.isFinite(cutoff) && cutoff > active.createdAt.getTime()
      ? new Date(cutoff)
      : active.createdAt;
  };
}

/**
 * Which enabled services have an env var (project-level or service-scoped)
 * modified since the active deployment went live — i.e. need an env-only
 * refresh. A project-level change (serviceId null) affects EVERY service.
 * Returns null when there's no active deployment/anchor to compare against.
 */
export async function resolveEnvDirtyServiceIds(
  project: Project,
  environment: string,
): Promise<Set<string> | null> {
  const anchorFor = await envDriftAnchors(project);
  if (!anchorFor) return null;

  const [meta, services] = await Promise.all([
    repos.project.listEnvVarChangeMeta(project.id, environment).catch(() => []),
    repos.service.listByProject(project.id).catch(() => []),
  ]);
  const enabledIds = services.filter((s) => s.enabled).map((s) => s.id);

  return new Set(enabledIds.filter(id => {
    const anchor = anchorFor(id);
    return meta.some(m => (m.serviceId === null || m.serviceId === id) && m.updatedAt > anchor);
  }));
}

/**
 * The env var NAMES that one service would pick up if it were recreated right
 * now — project-level changes included, because those land on every service.
 *
 * Empty means a restart is honest: nothing is pending, so bouncing the container
 * re-runs exactly the config it already has. Non-empty is the GH-615 case.
 *
 * Sorted and de-duplicated so the same drift always reports the same list (a
 * key can exist at both project and service scope).
 */
export async function resolveStaleEnvKeysForService(
  project: Project,
  environment: string,
  serviceId: string,
): Promise<string[]> {
  const anchorFor = await envDriftAnchors(project);
  if (!anchorFor) return [];
  const anchor = anchorFor(serviceId);

  const meta = await repos.project.listEnvVarChangeMeta(project.id, environment).catch(() => []);
  const keys = meta
    .filter((m) => m.updatedAt > anchor && (m.serviceId === null || m.serviceId === serviceId))
    .map((m) => m.key);
  return [...new Set(keys)].sort();
}
