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
 * Anchor: the ACTIVE deployment's `createdAt`. Any env var touched after that
 * deployment started is treated as not-yet-applied. Biases safe, and it clears
 * itself — a refresh deploy creates a new active deployment whose `createdAt`
 * post-dates the change, so the same var stops reading dirty without anyone
 * having to record what was applied.
 *
 * Values are never read here, only `updatedAt` and the key NAME, so no
 * decryption is involved and a key is safe to name in an API response.
 */

import { repos, type Project } from "@repo/db";
import { AppError } from "@repo/core";

/**
 * A restart cannot apply this service's pending env — Docker fixes a container's
 * environment at creation time, so bouncing it re-runs the OLD config.
 *
 * 409 rather than 400: the request is well-formed and the caller is allowed to
 * make it; the RESOURCE is in a state where the action would be a silent no-op.
 * The code lets a client branch on it, and `staleEnvKeys` names what is pending
 * so the operator can see the refusal is about the change they just made.
 */
export class ServiceConfigStaleError extends AppError {
  constructor(
    message: string,
    readonly staleEnvKeys: string[],
    readonly serviceName: string,
  ) {
    super(message, 409, "SERVICE_CONFIG_STALE");
    this.name = "ServiceConfigStaleError";
  }
}

/** The cutoff every drift question is asked against, or null when there is
 *  nothing deployed to compare with (first deploy → forceAll handles it). */
async function envDriftAnchor(project: Project): Promise<Date | null> {
  if (!project.activeDeploymentId) return null;
  const active = await repos.deployment.findById(project.activeDeploymentId).catch(() => null);
  return active?.createdAt ?? null;
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
  const anchor = await envDriftAnchor(project);
  if (!anchor) return null;

  const [meta, services] = await Promise.all([
    repos.project.listEnvVarChangeMeta(project.id, environment).catch(() => []),
    repos.service.listByProject(project.id).catch(() => []),
  ]);
  const enabledIds = services.filter((s) => s.enabled).map((s) => s.id);

  // A project-level (unscoped) env change touches every service.
  if (meta.some((m) => m.serviceId === null && m.updatedAt > anchor)) {
    return new Set(enabledIds);
  }
  const perService = new Set(
    meta
      .filter((m) => m.serviceId !== null && m.updatedAt > anchor)
      .map((m) => m.serviceId as string),
  );
  return new Set(enabledIds.filter((id) => perService.has(id)));
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
  const anchor = await envDriftAnchor(project);
  if (!anchor) return [];

  const meta = await repos.project.listEnvVarChangeMeta(project.id, environment).catch(() => []);
  const keys = meta
    .filter((m) => m.updatedAt > anchor && (m.serviceId === null || m.serviceId === serviceId))
    .map((m) => m.key);
  return [...new Set(keys)].sort();
}
