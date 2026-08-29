/**
 * Resolve "which discovered services did the user pick?" — once, for every step
 * of a migration that has to answer it.
 *
 * IDENTITY-FIRST, and that is the whole point. A container id is globally unique.
 * A compose SERVICE NAME is unique only WITHIN its compose project, so resolving a
 * selection by bare name against a server-wide pool silently pulls in every
 * same-named container on the host.
 *
 * That is not hypothetical, and it is not limited to the user's own stacks: the
 * Openship control plane runs as a compose stack whose services are literally
 * `api`, `dashboard`, `edge`, `postgres`, `redis` (apps/cli/src/lib/compose.ts,
 * docker/docker-compose.yml). Those containers carry no `openship.*` labels, so
 * the scan's `isOpenshipOwned` split leaves them in the generic candidate pool.
 * Migrating ANY foreign stack with a service named `postgres` therefore matched a
 * seventh container — Openship's own database — which `linkSelfAppServices` has
 * already bound to the control-plane project. The idempotency gate then refused
 * the whole migration with "already managed here by project \"Openship\"", and
 * every retry failed identically because nothing about that state changes (#584).
 *
 * Had the gate not caught it, the outcome was worse than a failed migration:
 * `buildAdoptedServiceRows` de-duplicates by suffixing, so the control plane's
 * postgres would have been adopted into the user's project as `postgres-2` — a
 * redeploy away from replacing Openship's own database container.
 *
 * The wizard has always HELD the unique identity (`svcUid` = containerId, which is
 * how it keys per-service env/route/volume state) and threw it away at the request
 * boundary, sending bare names. So this is not a new concept — it restores one that
 * existed client-side and was lost in transit.
 */

import type { DiscoveredService } from "./docker-reconcile";

export interface ServiceSelection {
  /** Container ids of the picked services — the wizard's `svcUid`. Authoritative
   *  when non-empty: every host-discovered service carries a real 64-hex id
   *  (`containerId: detail.id`, docker-reconcile.ts), so an id-scoped match is
   *  exact and cannot bleed across compose projects. */
  containerIds?: string[];
  /** Picked service names. The ONLY selector older clients send, and still the
   *  selector for services that have no container to identify. */
  names: string[];
}

/**
 * The picked subset of `services`, in the pool's own order.
 *
 * With `containerIds` present the match is by identity. Names are then consulted
 * only for pool entries that have NO container id — those cannot collide by id
 * and cannot be another stack's running container, so honoring them costs nothing
 * and keeps a mixed selection (a running container plus a declared-only service)
 * whole.
 *
 * With no `containerIds` this is the legacy server-wide name match, preserved
 * verbatim so a client that predates the id plumbing keeps working. It is still
 * ambiguous by construction — the gate's control-plane exclusion in
 * `migrate.service.ts` is what stops that ambiguity from reaching a user's
 * project, and is the reason this function does not try to guess.
 */
export function selectDiscoveredServices(
  services: DiscoveredService[],
  selection: ServiceSelection,
): DiscoveredService[] {
  const ids = new Set((selection.containerIds ?? []).filter((id) => Boolean(id)));
  const names = new Set(selection.names);
  if (ids.size === 0) return services.filter((s) => names.has(s.name));
  return services.filter((s) => (s.containerId ? ids.has(s.containerId) : names.has(s.name)));
}

/**
 * One discovered service's stable key — its container id, or its name when it has no
 * container (a compose file declares it but nothing is running).
 *
 * DELIBERATELY the same rule as the wizard's `svcUid` in ServerMigrationWizard.tsx,
 * which keys all of its per-service state (volume strategy, env overrides, route mode,
 * repo mapping) this way. The two must agree: the wizard sends maps under these keys
 * and the server reads them back with {@link perService}. If they diverge, every
 * per-service input silently falls back to the name and the collisions below return.
 */
export function serviceUid(s: DiscoveredService): string {
  return s.containerId ?? s.name;
}

/**
 * Read a per-service input (volume strategy, env override, subpath, repo mapping) for
 * ONE service, preferring its unique key over its name.
 *
 * Every one of these maps used to be keyed by service NAME alone. Two selected
 * containers that share a name — trivial across compose projects, where `postgres` and
 * `redis` are near-universal — therefore collapsed onto one entry: both got the first
 * one's volume strategy and env, so "reuse in place" could silently become "copy" (or
 * the reverse) on a service the operator never configured that way.
 *
 * Name is still the fallback, and must stay one: a repo compose service with no running
 * container is legitimately keyed by name, and an older client sends name keys for
 * everything.
 */
export function perService<T>(
  map: Record<string, T> | undefined,
  s: DiscoveredService,
): T | undefined {
  if (!map) return undefined;
  const uid = serviceUid(s);
  if (uid !== s.name && uid in map) return map[uid];
  return map[s.name];
}
