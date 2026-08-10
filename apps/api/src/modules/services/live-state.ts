/**
 * Live service state — the PURE matcher between a project's service rows and the
 * containers actually on the host.
 *
 * Why this exists: a service's *state* must never come from the database. The
 * old read path asked docker for `label=openship.deployment=<active dep id>` and
 * kept only rows whose stored container id appeared in the answer. That is fine
 * for a freshly deployed container and structurally broken for an ADOPTED one: a
 * same-server migration attaches already-running containers in place, and docker
 * labels are immutable in place — the attached container still carries the
 * PREVIOUS project/deployment labels, so a label-filtered query can never see
 * it. A running service then rendered "Stopped" forever.
 *
 * So identity is resolved from several angles, strongest first, and state is read
 * off whatever container that resolves to:
 *
 *   1. label     — `openship.project` + `openship.service` (a native deploy)
 *   2. name      — `openship-<slug>-<service>`, the name Openship itself mints
 *                  (createServiceContainer); survives relabeling and adoption
 *   3. trackedId — the id stored on the `service_deployment` row; the only key an
 *                  attached container with a FOREIGN name has. Identity hint
 *                  only — its stored `status` is never trusted
 *   4. compose   — `com.docker.compose.project`/`.service` for an adopted stack
 *                  the operator later recreated with `docker compose up`
 *
 * Assignment runs tier by tier across ALL services (not service by service), so
 * a weaker name match can't steal a container a stronger label match wants, and
 * each container is claimed by at most one service.
 */

import type { ServiceContainerState } from "@repo/core";

/** What the UI renders — the SAME vocabulary as the rest of the app (one union,
 *  so the badge maps and this matcher can't drift). Derived ONLY from live docker
 *  state, never from a persisted deploy status. */
export type LiveServiceStatus = ServiceContainerState;

/** The subset of `DockerContainerSummary` matching needs (keeps this module
 *  free of adapter imports so it stays trivially testable). */
export interface LiveContainerLike {
  id: string;
  names: string[];
  image?: string;
  /** Raw docker `State`: running | restarting | exited | created | paused | dead | removing. */
  state: string;
  /** Human status line — carries the health suffix, e.g. "Up 2 hours (unhealthy)". */
  status?: string;
  labels: Record<string, string>;
  ports?: Array<{ privatePort: number; publicPort?: number; type?: string }>;
  ip?: string;
}

export type LiveMatchKind = "label" | "name" | "trackedId" | "compose";

export interface LiveServiceMatch {
  /** The container this service ACTUALLY runs as — what logs/terminal/start
   *  must target. Null when nothing on the host matches. */
  containerId: string | null;
  status: LiveServiceStatus;
  ip: string | null;
  hostPort: number | null;
  image: string | null;
  /** Which identity key resolved it — surfaced in migration logs so an adopted
   *  service's provenance is visible. Null when unmatched. */
  matchedBy: LiveMatchKind | null;
  /** Names of OTHER containers that also claimed this service — a duplicate
   *  (e.g. an adopted container plus a later-deployed one under the canonical
   *  name). The strongest/running one wins; this records what was passed over. */
  duplicates: string[];
}

export interface ResolveLiveStateInput {
  /** The project's configured services (DB config — names and ids only). */
  services: Array<{ id: string; name: string }>;
  /** Every container on the host (label-agnostic `docker ps -a`). */
  live: LiveContainerLike[];
  projectId: string;
  /** Project slug — the middle segment of `openship-<slug>-<service>`. */
  slug: string;
  /** serviceId → container id recorded at deploy/attach time. Identity hint. */
  trackedIds?: Record<string, string | null | undefined>;
  /**
   * Restrict which identity keys may match. Defaults to all four.
   *
   * Exists for DESTRUCTIVE callers. `compose` matches on
   * `com.docker.compose.project === slug`, which is right for a READ (an adopted
   * stack the operator later recreated by hand still shows its true state) but
   * too loose for a delete: a migration that KEPT its source leaves the original
   * stack running under that same compose project name on the same host, and a
   * teardown that swept it would destroy containers and volumes the operator
   * deliberately chose to keep. Teardown therefore asks only for the keys that
   * PROVE ownership — `label`, `name`, `trackedId`.
   */
  tiers?: readonly LiveMatchKind[];
}

const UNMATCHED: Omit<LiveServiceMatch, "duplicates"> = {
  containerId: null,
  status: "stopped",
  ip: null,
  hostPort: null,
  image: null,
  matchedBy: null,
};

/** Canonical container name Openship gives a compose service on a server —
 *  mirrors `createServiceContainer` in packages/adapters/src/runtime/docker.ts. */
export function canonicalServiceContainerName(slug: string, serviceName: string): string | null {
  if (!slug || !serviceName) return null;
  return `openship-${slug}-${serviceName}`;
}

/**
 * Map one container's live docker state onto the UI vocabulary.
 *
 * `restarting` is deliberately NOT collapsed into `running` here (the deploy
 * reconciler does that on purpose, to avoid false drift while a container
 * bounces). For a status badge it matters: a crash-looping container reported
 * "Running" is the whole reason an operator can't see their stack is down.
 */
export function liveContainerStatus(c: Pick<LiveContainerLike, "state" | "status">): LiveServiceStatus {
  const state = (c.state ?? "").toLowerCase().trim();
  const health = /\(\s*(healthy|unhealthy|health:\s*starting)\s*\)/i.exec(c.status ?? "")?.[1]?.toLowerCase();
  if (state === "restarting") return "restarting";
  if (state === "running") {
    if (health === "unhealthy") return "failed";
    if (health?.startsWith("health:")) return "starting";
    return "running";
  }
  if (state === "dead") return "failed";
  // created | exited | paused | removing | anything unrecognized: it exists but
  // isn't serving. An exit code is NOT read as failure — a graceful `docker stop`
  // can exit non-zero, and "the user stopped it" must not render as a crash.
  return "stopped";
}

function firstHostPort(c: LiveContainerLike): number | null {
  for (const p of c.ports ?? []) {
    if (p.publicPort) return p.publicPort;
  }
  return null;
}

/** Rank for picking between several containers that match the SAME service. */
function livenessRank(c: LiveContainerLike): number {
  switch (liveContainerStatus(c)) {
    case "running":
      return 4;
    case "starting":
      return 3;
    case "restarting":
      return 2;
    case "failed":
      return 1;
    default:
      return 0;
  }
}

function toMatch(c: LiveContainerLike, matchedBy: LiveMatchKind, duplicates: string[]): LiveServiceMatch {
  return {
    containerId: c.id,
    status: liveContainerStatus(c),
    ip: c.ip ?? null,
    hostPort: firstHostPort(c),
    image: c.image ?? null,
    matchedBy,
    duplicates,
  };
}

const displayName = (c: LiveContainerLike) => c.names[0] ?? c.id.slice(0, 12);

/**
 * Resolve every service's live container + state. Pure: give it the service rows
 * and a `docker ps -a` snapshot, get back one entry per service.
 */
export function resolveLiveServiceState(input: ResolveLiveStateInput): Map<string, LiveServiceMatch> {
  const { services, live, projectId, slug, trackedIds = {}, tiers: allowed } = input;
  const result = new Map<string, LiveServiceMatch>();
  const claimed = new Set<string>();
  const pending = new Map(services.map((s) => [s.id, s]));

  const allTiers: Array<{ kind: LiveMatchKind; matches: (svc: { id: string; name: string }, c: LiveContainerLike) => boolean }> = [
    {
      kind: "label",
      matches: (svc, c) =>
        c.labels["openship.project"] === projectId && c.labels["openship.service"] === svc.name,
    },
    {
      kind: "name",
      matches: (svc, c) => {
        const canonical = canonicalServiceContainerName(slug, svc.name);
        return canonical != null && c.names.includes(canonical);
      },
    },
    {
      kind: "trackedId",
      // Short ids (12 chars) and full ids (64) both appear in stored rows, so
      // compare by prefix — but never on a stub too short to be unique.
      matches: (svc, c) => {
        const tracked = trackedIds[svc.id];
        if (!tracked || tracked.length < 12) return false;
        return c.id === tracked || c.id.startsWith(tracked) || tracked.startsWith(c.id);
      },
    },
    {
      kind: "compose",
      matches: (svc, c) =>
        !!slug &&
        c.labels["com.docker.compose.project"] === slug &&
        c.labels["com.docker.compose.service"] === svc.name,
    },
  ];

  // Restricted callers (teardown) drop the looser keys — see `tiers`.
  const tiers = allowed ? allTiers.filter((t) => allowed.includes(t.kind)) : allTiers;

  for (const tier of tiers) {
    if (pending.size === 0) break;
    for (const svc of [...pending.values()]) {
      const candidates = live.filter((c) => !claimed.has(c.id) && tier.matches(svc, c));
      if (candidates.length === 0) continue;
      // Prefer the liveliest candidate — an adopted-but-running container beats a
      // superseded exited one carrying the same identity.
      const winner = candidates.reduce((a, b) => (livenessRank(b) > livenessRank(a) ? b : a));
      // Losers stay unclaimed — the duplicate sweep below collects them (and any
      // weaker-tier claimant) in one place, so nothing is double-counted.
      result.set(svc.id, toMatch(winner, tier.kind, []));
      claimed.add(winner.id);
      pending.delete(svc.id);
    }
  }

  for (const svc of pending.values()) {
    result.set(svc.id, { ...UNMATCHED, duplicates: [] });
  }

  // Duplicate sweep: a container that ALSO answers to a matched service's
  // identity (the "two web containers" case — one adopted, one deployed under
  // the canonical name). It didn't win, but the operator needs to know it's
  // there; silently ignoring it is how a stale container keeps serving traffic.
  for (const svc of services) {
    const match = result.get(svc.id);
    if (!match?.containerId) continue;
    const extra = live
      .filter((c) => !claimed.has(c.id) && tiers.some((t) => t.matches(svc, c)))
      .map(displayName);
    if (extra.length > 0) match.duplicates = [...match.duplicates, ...extra];
  }
  return result;
}

/** One-line-per-service summary of a live resolution — used by the migration run
 *  log so an operator can see WHICH container each migrated service resolved to
 *  (and which resolved to nothing) instead of inferring it from a badge. */
export function describeLiveState(
  services: Array<{ id: string; name: string }>,
  live: LiveContainerLike[],
  matches: Map<string, LiveServiceMatch>,
): string[] {
  const byId = new Map(live.map((c) => [c.id, c]));
  return services.map((svc) => {
    const m = matches.get(svc.id);
    if (!m?.containerId) return `${svc.name} → NO container on the host`;
    const name = byId.get(m.containerId);
    const dupes = m.duplicates.length ? ` · also matched: ${m.duplicates.join(", ")}` : "";
    return `${svc.name} → ${name ? displayName(name) : m.containerId.slice(0, 12)} (${m.status}, by ${m.matchedBy})${dupes}`;
  });
}
