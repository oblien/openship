/**
 * A frozen compose snapshot that predates the deployment-meta redaction fix
 * carries `***` where a credential used to be, and a rollback replays it.
 *
 * The old write path ran the whole `deployment.meta` blob through the BUILD-LOG
 * credential scrubber, which rewrites URL userinfo to `***@`. `meta.composeServices`
 * is the frozen env of every compose service, so a
 * `DATABASE_URL=postgresql://app:secret@db:5432/app` was frozen as
 * `postgresql://***@db:5432/app`. `syncFromCompose` then wrote that onto the
 * live service rows, and the container was built from them — so a rollback
 * reproduced the breakage it was supposed to undo, while reporting success.
 *
 * `sanitizeDeploymentMeta` stops NEW snapshots from being mangled. This handles
 * the ones already on disk: a redacted value is not a value, so it must never
 * overwrite a live one. Every key whose frozen value carries the redaction
 * shape takes the LIVE row's value instead, which is exactly what the operator
 * last deployed successfully with.
 *
 * The shape is narrow on purpose (`://***@`, not a bare `***`) for the reason
 * `isRedactedCommand` documents: a real DSN has credentials in that position and
 * a credential-less URL has no `@` at all, so this cannot condemn a value the
 * user wrote themselves.
 */

import { REDACTED_USERINFO_MARKER } from "@repo/adapters";
import { serviceKind } from "../../../lib/deployable-service";
import type { DeployableService } from "../../../lib/deployable-service";

/** Was this frozen value mangled by the credential scrubber? */
export function isRedactedUserinfo(value: string | null | undefined): boolean {
  return typeof value === "string" && value.includes(REDACTED_USERINFO_MARKER);
}

/**
 * Does this snapshot hold anything worth repairing at all?
 *
 * Split out so the caller can skip the live-row read entirely on the common
 * path — a rollback of a release frozen after the fix must not pay a query to
 * learn there is nothing to do.
 */
export function hasRedactedFrozenEnv(
  composeServices: readonly DeployableService[] | undefined,
): boolean {
  if (!composeServices?.length) return false;
  return composeServices.some(
    (service) =>
      serviceKind(service) === "compose" &&
      Object.values(service.environment ?? {}).some(isRedactedUserinfo),
  );
}

/** Live compose env, keyed by service name. Values are the row's own. */
export type LiveServiceEnvironment = ReadonlyMap<string, Record<string, string>>;

/**
 * Replace redacted frozen env values with the live ones. Returns the input
 * UNCHANGED when nothing is redacted, so the common case allocates nothing and
 * callers can compare by reference.
 *
 * Non-compose entries (monorepo sub-apps) pass through untouched, matching the
 * `syncFromCompose` filter this feeds — their env is applied from the live rows
 * directly.
 */
export function replaceRedactedFrozenEnv(
  composeServices: readonly DeployableService[] | undefined,
  live: LiveServiceEnvironment,
): readonly DeployableService[] {
  if (!composeServices?.length) return composeServices ?? [];
  let changed = false;

  const out = composeServices.map((service) => {
    if (serviceKind(service) !== "compose") return service;
    const environment = service.environment;
    if (!environment) return service;

    const liveEnv = live.get(service.name ?? "");
    if (!liveEnv) return service;

    let envChanged = false;
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(environment)) {
      if (isRedactedUserinfo(value) && liveEnv[key] !== undefined) {
        next[key] = liveEnv[key];
        envChanged = true;
      } else {
        next[key] = value;
      }
    }
    if (!envChanged) return service;
    changed = true;
    return { ...service, environment: next };
  });

  return changed ? out : composeServices;
}
