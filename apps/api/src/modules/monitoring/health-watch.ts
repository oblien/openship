/**
 * Steady-state container health watch — the loop that notices a workload broke
 * at 3am instead of when a user complains.
 *
 * Openship checks a container's health exactly once today: the ~15s post-deploy
 * stabilization window. After that nobody looks again. The project page's status
 * pill *is* live, but only while a human is staring at it. This closes that gap by
 * asking every server's Docker daemon the same question once a minute and routing
 * anything conclusive through the incident state machine into the existing
 * notification channels.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 * Grouped by (server × organization), NOT by project: a box with thirty projects
 * gets ONE `docker ps -a`, not thirty SSH bridges. The org is part of the key
 * because SSH credentials are resolved per-org — sharing one connection across
 * orgs would read a box with the wrong identity.
 *
 * ── Why the poll stays authoritative ──────────────────────────────────────────
 * The poll reads STATE, so it is self-correcting: `RestartCount` is monotonic and
 * `State` is durable, and whatever a tick missed the next tick sees. Docker's
 * event stream reads TRANSITIONS — a dropped connection or a daemon restart loses
 * them for good, and a container stuck in `created`, or already down before this
 * process booted, or unhealthy since before we connected, emits nothing at all.
 *
 * So events never replace this sweep; they only make it run EARLY for one server
 * group (`runHealthWatch({onlyServerKeys})`), which cuts detection from ~90s to
 * ~10s and recovery to ~3s. The stream classifies nothing and duplicates none of
 * the gates below — see modules/monitoring/container-events.ts. With events
 * disabled or broken, behavior is exactly this file's, one minute at a time.
 *
 * ── The four false positives this exists to suppress ──────────────────────────
 * A naive "alert when a container isn't running" watcher gets muted within a day.
 * Each gate below is one class of alert that would be wrong:
 *
 *   1. A deploy in flight legitimately destroys and recreates containers.
 *   2. An operator ran `docker stop`, or disabled the project. Intent is
 *      invisible in Docker's state — a stopped container looks identical either
 *      way — so it's read from `service_deployment.status` and `project.disabled_at`.
 *   3. A box we can't reach tells us nothing about the thirty services on it. One
 *      alert for the box; every project on it is skipped, nothing auto-resolved.
 *   4. A fault must be seen twice before it pages, and an incident notifies on
 *      open / escalation / recovery only — never per tick. A workload that keeps
 *      breaking straight after it recovers has to earn its all-clear, so a flapping
 *      service is one episode rather than an alert pair per cycle.
 *
 * ── Cost on a healthy instance ────────────────────────────────────────────────
 * Restart baselines and agreement counters live in a module-level Map, so a tick
 * where nothing is wrong performs ZERO incident writes. A control-plane restart
 * just re-baselines: the first tick after boot can't diff restart counts, which
 * costs at most one extra minute of detection latency.
 */

import { repos, type Deployment, type Project, type Service, type ServiceIncident } from "@repo/db";
import {
  getPlatform,
  type ContainerStabilitySample,
  type RuntimeAdapter,
} from "@repo/adapters";
import { safeErrorMessage, withTimeout } from "@repo/core";
import {
  resolveDeploymentRuntimeForRead,
  resolveEffectiveTarget,
  type DeploymentMeta,
} from "../../lib/deployment-runtime";
import { deploymentIsInFlight } from "../projects/deployment-flags";
import { mapWithLimit } from "../../lib/map-with-limit";
import { liveContainerStatus, resolveLiveServiceState } from "../services/live-state";
import { readLogTail } from "../deployments/stability-audit.service";
import {
  classifySteadyState,
  type SteadyStateVerdict,
  type WorkloadIncidentKind,
} from "./steady-state";
import {
  recordServerUnreachable,
  recordWorkloadFailure,
  resolveServerIncident,
  resolveWorkloadIncident,
  willNotifyFor,
  type WorkloadTarget,
} from "./incident.service";

/** Consecutive observations that must agree before a fault opens or escalates. */
const AGREE_TICKS = 2;
/**
 * Minimum spacing between two observations for the second to COUNT toward
 * agreement.
 *
 * `AGREE_TICKS` used to imply this for free, back when observations were 60s
 * apart. Event-accelerated runs arrive in bursts (a redeploy or an OOM kill emits
 * several transitions within a second), and without a floor "must be seen twice"
 * would degrade to "must be seen twice, possibly in the same instant". A closer
 * observation HOLDS the counter rather than resetting it — the fault is still
 * there, we just haven't watched it for long enough yet.
 */
const MIN_CONFIRM_GAP_MS = 4_000;
/**
 * How long a restart baseline stays ANCHORED — observations inside this window
 * accumulate against it instead of re-anchoring to the count they just read.
 *
 * Deliberately under the 60s poll interval, so a scheduled tick always re-anchors
 * and the unaccelerated path behaves exactly as it did before this existed. It is
 * the accelerated path that needs it: two observations 3s apart used to re-anchor
 * on the first, so a container restarting every few seconds produced deltas of 0
 * or 1 that never reached `CRASH_RESTART_DELTA` — the accelerator masking the very
 * loop it was added to catch sooner.
 */
const RESTART_WINDOW_MS = 45_000;
/**
 * Past this age a baseline proves nothing about NOW and the delta rule is skipped.
 *
 * A workload absent from a tick (unreachable box, in-flight deploy, exhausted
 * inspect budget) keeps its MEMORY entry, so without a ceiling the first
 * successful observation after an hour of silence would read an hour of ordinary
 * restarts as one window's worth and page about a crash loop that ended long ago.
 */
const RESTART_STALE_MS = 3 * 60_000;
/**
 * Quiet window after a deployment stops moving. Containers churn for a while
 * after a deploy reports done (compose recreates, dependency waits, the #335
 * stabilization watch itself), and every one of those looks like a fault.
 */
const DEPLOY_GRACE_MS = 2 * 60_000;
/** Servers swept concurrently. Each holds one SSH bridge while it works. */
const SERVER_CONCURRENCY = 4;
/**
 * Hard deadline on one (server × org) group.
 *
 * Without it a wedged transport takes the whole feature down for good: every entry
 * point serializes on `sweepChain`, so a `listAllContainers` that never settles —
 * a half-open SSH bridge is the realistic way — blocks every later sweep,
 * scheduled and event-accelerated alike, for the life of the process. The job
 * runner's own timeout marks the run failed but cannot cancel the body, so nothing
 * recovers it and nothing says so: a monitor that silently stopped monitoring.
 *
 * Falling into the gate-3 catch is the right outcome rather than a workaround — a
 * box that cannot answer inside 90s IS unreachable, and that is the incident an
 * operator needs. Generous enough that no healthy box trips it: the whole budget
 * of 120 inspects over a laggy bridge is a few seconds.
 */
const GROUP_DEADLINE_MS = 90_000;
/**
 * What `withTimeout` rejects a wedged group read with. Hoisted because gate 3
 * COMPARES it: a deadline means the daemon stopped answering, which is a different
 * thing from an exception thrown by our own code after it answered.
 */
const GROUP_DEADLINE_REASON = `no answer from the docker daemon within ${Math.round(
  GROUP_DEADLINE_MS / 1000,
)}s`;
/** Inspects issued concurrently against one daemon. */
const INSPECT_CONCURRENCY = 8;
/**
 * Ceiling on inspects per server per tick.
 *
 * Every watched container is inspected, not just the ones the container LIST
 * already looks unhappy about — that list has no `RestartCount`, and a container
 * that crashes every 30s reads "Up 12 seconds / running" on every single poll.
 * Skipping the inspect would mean skipping exactly the crash loop this feature
 * exists to catch. An inspect is ~2ms locally and ~5ms over the bridge, so a
 * realistic box never reaches this cap; when one does, the summary reports how
 * many were dropped rather than silently claiming full coverage.
 */
const MAX_INSPECTS_PER_SERVER = 120;
/** Log lines attached to an alert. Enough to see a stack trace's head. */
const LOG_TAIL_LINES = 12;
/**
 * How soon after a recovery a fresh break marks a workload as FLAPPING.
 *
 * Generous on purpose: the cost of being wrong is that one genuine, unrelated
 * break inside the window gets its all-clear `RECOVERY_HOLD_MS` late, which nobody
 * notices. The cost of being too tight is the storm this exists to stop.
 */
const FLAP_WINDOW_MS = 10 * 60_000;
/**
 * Continuous health a KNOWN-FLAPPING workload must show before its incident is
 * closed and the recovery announced.
 *
 * A first recovery is always immediate — recovery is not the direction that needs
 * hysteresis, and an operator watching a fix land wants the all-clear promptly. It
 * is the second, third and fourth cycle that need damping: an oscillating
 * healthcheck never stops its container, so nothing about it reads as a crash loop,
 * and every cycle used to produce a full open+resolve notification pair. Docker's
 * own restart backoff can hold a container in that shape indefinitely, so
 * "indefinitely, several pairs a minute" was reachable — which is precisely how an
 * operator learns to ignore the channel.
 *
 * Deliberately NOT reported through `summary.pending`: that field is the event
 * accelerator's cue to take another observation, and a multi-minute hold must not
 * be read as "sweep this box again in 6 seconds" for its whole duration.
 */
const RECOVERY_HOLD_MS = 2 * 60_000;

/**
 * Dedup key for a single-app deployment.
 *
 * NOT the container name: a single-app container is named
 * `openship-<project>-<deploymentId>`, so every redeploy would mint a new key,
 * abandon the open incident, and re-page. The project owns exactly one app
 * workload, so a constant is the stable identity.
 */
export const SINGLE_APP_KEY = "__app__";

export interface HealthWatchSummary {
  /** Index signature so this doubles as the job runner's `JobSummary`. */
  [key: string]: number;
  servers: number;
  projects: number;
  workloads: number;
  opened: number;
  escalated: number;
  resolved: number;
  /** Incidents closed because the workload stopped being watched (see below). */
  stale: number;
  unreachable: number;
  /**
   * Projects skipped because their deployment record names a target that cannot be
   * resolved to a daemon — see `resolveWatchTargets`. Deliberately not `errors` (the
   * bug isn't ours) and not `unreachable` (the box isn't the problem, the record is).
   */
  unresolved: number;
  /** Watched containers we ran out of inspect budget for. */
  skipped: number;
  /**
   * Observations that proved neither health nor fault, so nothing was opened and
   * nothing closed. Persistently non-zero means the inspect budget is too small for
   * this fleet: past it, a workload that is merely NOT RUNNING can't be explained.
   */
  indeterminate: number;
  /**
   * Faults seen but not yet confirmed. The event accelerator reads this to decide
   * whether a second observation is worth scheduling — an out-of-band run produces
   * only ONE, and one never confirms anything.
   */
  pending: number;
  /** Recovered workloads whose all-clear is being held back — see `RECOVERY_HOLD_MS`. */
  recovering: number;
  errors: number;
}

/** Per-workload memory between observations. Lives in this process only, by design. */
interface WatchMemory {
  /** The container this baseline belongs to — a recreate invalidates the counts. */
  containerId: string;
  restartCount: number | null;
  /** When `restartCount` was anchored — the delta window's start. See `resolveRestartBaseline`. */
  restartCountAtMs: number;
  /** The fault the last observation saw, and how many agreed in a row. */
  kind: WorkloadIncidentKind | null;
  agreed: number;
  /** When the last COUNTED observation landed — see `MIN_CONFIRM_GAP_MS`. */
  lastSeenAtMs: number;
  /** Consecutive observations already seen in `created` (never started). */
  createdTicks: number;
  /** Start of the current unbroken run of healthy observations; null while faulty. */
  healthySince: number | null;
  /** When we last closed an incident for this workload — the flap detector's anchor. */
  lastResolvedAtMs: number | null;
}

/**
 * Per-workload observation state, for this process only.
 *
 * Deliberate, and the split is drawn on one rule: everything whose loss would MISS a
 * page or send a SECOND one lives in the incident row — whether one is open, at which
 * kind, and whether it has been notified. What lives here is only ever evidence being
 * accumulated toward a decision not yet made: the agreement counter, the restart
 * baseline, the flap anchors. Losing that costs re-earning the evidence, nothing more.
 *
 * So a control-plane restart mid-outage cannot re-page. The sweep re-earns its two
 * agreeing observations, then finds the open incident already at that kind and
 * `willNotifyFor` says no. What a restart does forfeit is exactly one cycle of flap
 * damping: `lastResolvedAtMs` starts null, so the first recovery after a restart is
 * announced rather than held, and the anchor is re-learned from that same resolve. One
 * extra all-clear per flapping workload per restart is the price of keeping per-tick
 * state out of the database — restarts are rare, and the failure direction is one
 * message too many rather than silence. Both halves are pinned by tests.
 */
const MEMORY = new Map<string, WatchMemory>();

/** The fields of a `docker ps -a` row this module reads. */
interface ListedContainer {
  id: string;
  state: string;
  /** Human status line — carries the `(unhealthy)` suffix. */
  status?: string;
}

/** One thing on a host we expect to be up. */
interface Workload {
  serviceId: string | null;
  serviceKey: string;
  serviceName: string;
  containerId: string;
  /** False when the operator stopped this specific service. */
  expectRunning: boolean;
}

interface Candidate {
  project: Project;
  dep: Deployment;
  meta: DeploymentMeta;
  /**
   * The daemon this project's containers actually live on — `null` for the control
   * plane's own socket. Resolved the way the read runtime resolves it, NOT copied from
   * `meta.serverId`; see `resolveWatchTargets`.
   */
  serverId: string | null;
}

function memoryKey(projectId: string, serviceKey: string): string {
  return `${projectId}:${serviceKey}`;
}

/** Inverse of `memoryKey`'s left half. Ids are base64url, so they carry no colon. */
function projectIdFromMemoryKey(key: string): string {
  const split = key.indexOf(":");
  return split < 0 ? key : key.slice(0, split);
}

/** Stand-in server id for the control plane's own Docker socket. */
const LOCAL_SERVER_KEY = "__local__";

/**
 * The sweep's unit of work: one (server × organization). Exported so the event
 * accelerator names groups exactly the way the sweep does — the whole filter
 * contract is this string.
 */
export function watchGroupKey(serverId: string | null, organizationId: string): string {
  return `${serverId ?? LOCAL_SERVER_KEY}::${organizationId}`;
}

export function parseWatchGroupKey(key: string): {
  serverId: string | null;
  organizationId: string;
} {
  const split = key.indexOf("::");
  const serverId = split < 0 ? key : key.slice(0, split);
  return {
    serverId: serverId === LOCAL_SERVER_KEY ? null : serverId,
    organizationId: split < 0 ? "" : key.slice(split + 2),
  };
}

/** Where a deployment's containers live, as the READ runtime will resolve it. */
type WatchTarget =
  /** A daemon we can name. `null` is the control plane's own socket. */
  | { kind: "docker"; serverId: string | null }
  /** Runs on Oblien — nothing here can observe it. */
  | { kind: "cloud" }
  /** The record names a target that resolves to no daemon. See below. */
  | { kind: "unresolved"; reason: string };

/**
 * Which Docker daemon will each deployment's read runtime actually talk to?
 *
 * The group key has to answer exactly this. `readServerGroup` resolves ONE runtime per
 * group and judges every project in it against that single `docker ps -a`, so a key that
 * disagrees with the transport merges two boxes into one group — and every workload whose
 * containers live on the other box reads as missing. `missingContainerVerdict` is a
 * confirmed `down`, so that mistake pages for a perfectly healthy service; the mirror
 * image is a real outage hidden behind a stranger's container list.
 *
 * `meta.serverId ?? null` is NOT that answer:
 *
 *   - "deploys to a server, records no serverId" is a supported meta, not corruption —
 *     `resolveEffectiveTarget` says so in as many words ("UI chose 'server' target but
 *     serverId may be missing → still route to SSH") and the webmail installer writes it.
 *     It resolves to the org's ONE server, while a null key names the local socket.
 *   - `cloudWorkspaceId` is the canonical "this is a cloud project" test (project.ts),
 *     and it outranks a stale local `deployTarget` on the active deployment: after a
 *     promote the workload runs on Oblien whatever the last local snapshot says.
 *
 * Unresolvable is its own answer, and it is neither the box's fault nor ours: a serverId
 * pointing at a row that no longer exists (nothing stops a server being deleted while
 * projects still target it) or that belongs to another org, or a server target in an org
 * with no server or several. Those projects are skipped WITHOUT retiring — an
 * unresolvable target is not evidence a workload recovered, and unlike a soft-deleted
 * project it is still listed and still fixable, so its incidents stay as they are.
 * Reading them as "unreachable box" instead would be worse than useless: gate 3 can't
 * even record that, because opening an incident against a dangling serverId violates the
 * incident's foreign key, so the alert dies in a catch and the projects go quietly
 * unmonitored for the life of the install.
 */
async function resolveWatchTargets(
  base: Parameters<typeof resolveEffectiveTarget>[0],
  projects: Iterable<{ project: Project; dep: Deployment; meta: DeploymentMeta }>,
): Promise<Map<string, WatchTarget>> {
  const out = new Map<string, WatchTarget>();
  const pending: { dep: Deployment; meta: DeploymentMeta }[] = [];
  const referenced = new Set<string>();
  /** Orgs whose server target names no server — they fall back to their only one. */
  const fallbackOrgs = new Set<string>();

  for (const { project, dep, meta } of projects) {
    const effective = resolveEffectiveTarget(base, meta);
    if (project.cloudWorkspaceId || effective === "cloud") {
      out.set(dep.id, { kind: "cloud" });
      continue;
    }
    if (effective !== "server") {
      out.set(dep.id, { kind: "docker", serverId: null });
      continue;
    }
    pending.push({ dep, meta });
    if (meta.serverId) referenced.add(meta.serverId);
    else fallbackOrgs.add(dep.organizationId);
  }
  if (pending.length === 0) return out;

  // One round trip for every row named, plus one per org that has to fall back — normally
  // none, since a deploy stamps the id it used.
  const rows = await repos.server.getMany([...referenced]);
  const fallback = new Map<string, string | null>();
  for (const organizationId of fallbackOrgs) {
    const owned = await repos.server.listByOrganization(organizationId);
    fallback.set(organizationId, owned.length === 1 ? (owned[0]?.id ?? null) : null);
  }

  for (const { dep, meta } of pending) {
    if (!meta.serverId) {
      const only = fallback.get(dep.organizationId) ?? null;
      out.set(
        dep.id,
        only
          ? { kind: "docker", serverId: only }
          : {
              kind: "unresolved",
              reason: "deploys to a server but records none, and its organization has no single server to fall back to",
            },
      );
      continue;
    }
    const row = rows.get(meta.serverId);
    // Strict org equality, exactly as `getInOrganization` does it — `getMany` is not
    // org-scoped, and a row from another org is one this deployment cannot reach.
    out.set(
      dep.id,
      row && row.organizationId === dep.organizationId
        ? { kind: "docker", serverId: row.id }
        : {
            kind: "unresolved",
            reason: `targets server ${meta.serverId}, which this organization no longer has`,
          },
    );
  }
  return out;
}

/**
 * Does this deployment's app run as a container at all?
 *
 * Mirrors `resolveDeploymentPlatform`'s derivation. A bare (systemd) deploy also
 * writes a non-null `containerId` — it stores the unit handle there — so
 * "containerId is set" is NOT sufficient to conclude there's a container to
 * inspect. Its compose SERVICES are still containers and stay watched; only the
 * app workload is excluded.
 */
function runsAsContainer(meta: DeploymentMeta): boolean {
  const mode = meta.runtimeMode ?? (getPlatform().runtime.name === "docker" ? "docker" : "bare");
  return mode === "docker";
}

export interface HealthWatchOptions {
  /**
   * Restrict this run to these `watchGroupKey()` groups — how the event
   * accelerator asks for one box to be re-read immediately. A filtered run also
   * skips stale-incident reaping (see below), so it can only ever open, escalate
   * or resolve incidents for the groups it actually looked at.
   */
  onlyServerKeys?: ReadonlySet<string>;
}

/** Serializes every entry point — see `runHealthWatch`. */
let sweepChain: Promise<unknown> = Promise.resolve();

/**
 * One observation pass. Never throws: a single unreachable box or malformed
 * project must not take the sweep down, so every failure is counted and the rest
 * of the run continues.
 *
 * Runs are SERIALIZED, scheduled tick and event-accelerated run alike. The
 * agreement counters in `MEMORY` are module state, and two interleaved passes
 * would both advance them off the same fault within milliseconds of each other —
 * the DB's partial unique index protects the incident ROWS, not the counters.
 */
export function runHealthWatch(opts?: HealthWatchOptions): Promise<HealthWatchSummary> {
  const next = sweepChain.then(
    () => sweepOnce(opts),
    () => sweepOnce(opts),
  );
  sweepChain = next.catch(() => {});
  return next;
}

async function sweepOnce(opts?: HealthWatchOptions): Promise<HealthWatchSummary> {
  const summary: HealthWatchSummary = {
    servers: 0,
    projects: 0,
    workloads: 0,
    opened: 0,
    escalated: 0,
    resolved: 0,
    stale: 0,
    unreachable: 0,
    unresolved: 0,
    skipped: 0,
    indeterminate: 0,
    pending: 0,
    recovering: 0,
    errors: 0,
  };

  const base = getPlatform().target;
  const projects = await repos.project.listAllForScan();
  if (projects.length === 0) return summary;

  const activeIds = projects
    .map((p) => p.activeDeploymentId)
    .filter((id): id is string => Boolean(id));
  const [activeDeps, latestDeps, openIncidents] = await Promise.all([
    repos.deployment.findManyById(activeIds),
    repos.deployment.findLatestByProjects(projects.map((p) => p.id)),
    repos.serviceIncident.listOpen(),
  ]);

  const openByKey = new Map<string, ServiceIncident>();
  for (const incident of openIncidents) {
    if (incident.projectId) openByKey.set(memoryKey(incident.projectId, incident.serviceKey), incident);
  }

  const now = Date.now();
  const candidates: Candidate[] = [];
  /** Projects that will never be watched again as they stand — see `stale`. */
  const retired = new Set<string>();

  const live: { project: Project; dep: Deployment; meta: DeploymentMeta }[] = [];
  for (const project of projects) {
    const dep = project.activeDeploymentId ? activeDeps.get(project.activeDeploymentId) : undefined;
    // Nothing deployed, or the operator turned it off. Both are permanent until
    // someone acts, so an open incident is closed silently rather than announced
    // as a recovery — the workload didn't come back, it stopped being watched.
    if (!dep || project.disabledAt) {
      retired.add(project.id);
      continue;
    }
    live.push({ project, dep, meta: (dep.meta ?? {}) as DeploymentMeta });
  }

  const watchTargets = await resolveWatchTargets(base, live);
  /** Deployment records naming a target we can't resolve — logged once per tick. */
  const unresolved: string[] = [];

  for (const { project, dep, meta } of live) {
    const target = watchTargets.get(dep.id);
    // Cloud workloads run on Oblien, whose runtime declares no stability probe.
    if (!target || target.kind === "cloud") {
      retired.add(project.id);
      continue;
    }
    if (target.kind === "unresolved") {
      unresolved.push(`${project.slug} (${target.reason})`);
      continue;
    }
    // Gate 1: a deploy in flight (or one that only just settled) is recreating
    // containers. Skipped WITHOUT retiring — an open incident stays open, because
    // we genuinely don't know anything about this project right now.
    const newest = latestDeps.get(project.id) ?? dep;
    if (deploymentIsInFlight(newest)) continue;
    if (now - newest.updatedAt.getTime() < DEPLOY_GRACE_MS) continue;

    candidates.push({ project, dep, meta, serverId: target.serverId });
  }

  if (unresolved.length > 0) {
    summary.unresolved = unresolved.length;
    console.warn(
      `[health-watch] not watched, unresolvable deploy target: ${unresolved.join("; ")}`,
    );
  }

  // Group by server AND org: the SSH credentials for a box are org-scoped.
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = watchGroupKey(candidate.serverId, candidate.dep.organizationId);
    const bucket = groups.get(key);
    if (bucket) bucket.push(candidate);
    else groups.set(key, [candidate]);
  }
  /** Every group this pass COULD have swept — the accelerator's subscribe list. */
  const allGroupKeys = [...groups.keys()];
  const filtered = opts?.onlyServerKeys;
  if (filtered) {
    for (const key of allGroupKeys) if (!filtered.has(key)) groups.delete(key);
  }
  summary.servers = groups.size;

  const sweptGroups = [...groups.values()];
  const serviceRows = await repos.service.listByProjects(
    sweptGroups.flat().map((c) => c.project.id),
  );

  /** Projects whose container list we actually read this tick. */
  const swept = new Set<string>();
  /** Workload keys we produced a verdict for. */
  const visited = new Set<string>();

  await mapWithLimit(sweptGroups, SERVER_CONCURRENCY, async (group) => {
    await sweepServerGroup({ group, serviceRows, openByKey, swept, visited, summary });
  });

  if (filtered) {
    // Reaping below reasons over EVERY open incident against globally-populated
    // sets, so on a one-group run every other box's workloads look unwatched and
    // would be resolved out from under a live outage. A filtered run is an early
    // re-read of one box, not a statement about the fleet.
    return summary;
  }

  /**
   * Did this pass reach a conclusion about the project — including "there is nothing
   * left to watch"?
   *
   * `retired` and `swept` between them cover every project the scan RETURNED. They do
   * not cover a project it never returned: `listAllForScan` filters out soft-deleted
   * rows and caps the scan, and a soft delete deliberately keeps the row (the workload
   * and its data stay on the server), so the incident's `onDelete: "cascade"` never
   * fires. Absent from both sets meant "don't touch it" — so a soft-deleted project's
   * incident stayed open forever on the Health tab, and its baselines stayed in MEMORY
   * for the life of the process. Absent from the scan is the strongest possible form of
   * "nobody is watching this": no later tick can ever confirm it either.
   */
  const known = new Set(projects.map((p) => p.id));
  const settled = (projectId: string) =>
    retired.has(projectId) || swept.has(projectId) || !known.has(projectId);

  // ── Close what nobody is watching any more ─────────────────────────────────
  // An incident survives its workload: a service row deleted, a release that no
  // longer deploys that service, a project disabled or moved to cloud. Left
  // alone these stay open forever and the Health tab lies. Closed WITHOUT a
  // recovery notification — "is back up" would be false.
  //
  // Deliberately scoped by `settled`. A project skipped for an unreachable server or
  // an in-flight deploy is none of those things, and its incident is left exactly as
  // it was.
  for (const incident of openIncidents) {
    if (!incident.projectId) continue;
    const key = memoryKey(incident.projectId, incident.serviceKey);
    if (visited.has(key)) continue;
    if (!settled(incident.projectId)) continue;
    if (await repos.serviceIncident.resolve(incident.id)) summary.stale++;
    MEMORY.delete(key);
  }

  // ── Forget workloads nobody will ask about again ────────────────────────────
  // The reap above only reaches keys that had an OPEN incident. A HEALTHY workload
  // that stops being watched — a compose service dropped from the release, a
  // project deleted or disabled — left its baseline behind forever, so a
  // long-running control plane on a churning instance accumulated one entry per
  // workload it had ever seen.
  //
  // Same `settled` scoping as the reap, for the same reason: a project skipped for an
  // unreachable box or an in-flight deploy keeps its baselines AND its agreement
  // counters — throwing those away would cost a tick of detection latency the
  // moment the box answers again.
  for (const key of MEMORY.keys()) {
    if (visited.has(key)) continue;
    if (settled(projectIdFromMemoryKey(key))) MEMORY.delete(key);
  }

  // The poll owns the event layer's lifecycle: each full pass renews the leases of
  // the groups it just enumerated, and a subscription whose lease goes unrenewed
  // closes itself. So there is no startup hook, disabling this job drains the
  // streams, a box that loses its last project drops its subscription — and the
  // accelerator cannot outlive the sweep it accelerates. Imported lazily because
  // the accelerator imports us back; it returns without waiting on connects.
  try {
    const { renewEventWatchers } = await import("./container-events");
    await renewEventWatchers(allGroupKeys);
  } catch (err) {
    summary.errors++;
    console.error(`[health-watch] event watcher renewal failed: ${safeErrorMessage(err)}`);
  }

  return summary;
}

interface GroupContext {
  group: Candidate[];
  serviceRows: Map<string, Service[]>;
  openByKey: Map<string, ServiceIncident>;
  swept: Set<string>;
  visited: Set<string>;
  summary: HealthWatchSummary;
}

/**
 * The server row an unreachable-box incident hangs on.
 *
 * A local group has no `serverId` — its deployment targets the control plane's own
 * docker socket — but it does have a server ROW, and that row is what the incident is
 * keyed to. Both directions have to resolve it the same way: resolving it only on the
 * way IN left a local box's incident with nothing that could ever close it, so one
 * hiccup on the control plane's own socket meant the Health tab reported an unreachable
 * server forever and the "is answering again" was never sent.
 */
async function incidentServerId(
  serverId: string | null,
  organizationId: string,
): Promise<string | null> {
  return serverId ?? (await repos.server.findLocal(organizationId))?.id ?? null;
}

async function sweepServerGroup(ctx: GroupContext): Promise<void> {
  const { group, summary } = ctx;
  const first = group[0];
  if (!first) return;
  const serverId = first.serverId;
  const organizationId = first.dep.organizationId;

  /** Published the moment it exists, so the `finally` still disposes it on timeout. */
  const handle: GroupHandle = {};
  try {
    await withTimeout(
      readServerGroup(ctx, first, { serverId, organizationId, handle }),
      GROUP_DEADLINE_MS,
      GROUP_DEADLINE_REASON,
    );
  } catch (err) {
    const reason = safeErrorMessage(err);
    // Set before anything else: from here the group's verdict is decided WITHOUT
    // whatever is still running inside it, so nothing still running inside it may
    // write. See `GroupHandle.abandoned`.
    handle.abandoned = true;
    // A group that threw is a group we cannot reason about AS A WHOLE, whether or
    // not the box answered: the reap scopes itself to `swept`, and half a sweep
    // would let it stale-close incidents for workloads whose observation never ran
    // (a project is marked swept before its workloads are evaluated, and a deadline
    // can land between the two).
    for (const candidate of group) ctx.swept.delete(candidate.project.id);

    // Gate 3, and the only thing it is allowed to mean: the container list never
    // came back. PAST that point the daemon has demonstrably answered, so a failure
    // is ours — a rejected incident write, a bug — and reporting it as an unreachable
    // box tells every project on a healthy machine that it can't be monitored, with
    // a Postgres error for a message. This tick may even have just announced the box
    // answering again (`readServerGroup` closes that incident before the loop), so
    // the pair would read "is answering again" followed by "can't reach Docker".
    //
    // The DEADLINE is exempt: an inspect that hangs after the list came back is a
    // wedged daemon or a dead bridge, which is precisely what gate 3 is for. A
    // thrown error is the ours-not-theirs case — the inspect path swallows its own
    // rejections, so nothing else the daemon does arrives here as an exception.
    if (handle.listed && reason !== GROUP_DEADLINE_REASON) {
      summary.errors++;
      console.error(
        `[health-watch] ${serverId ?? "local docker"}: sweep failed after the daemon answered: ${reason}`,
      );
      return;
    }

    // One incident for the box; every project in this group keeps whatever incidents
    // it had, and none of them are retired (they're absent from `swept`).
    summary.unreachable++;
    const target = await incidentServerId(serverId, organizationId);
    if (!target) {
      // No server row to hang the incident on (a control-plane docker socket that
      // was never registered). Nothing to dedup against, so don't notify at all —
      // an undeduped alert here would repeat every minute.
      summary.errors++;
      console.error(`[health-watch] local docker unreachable: ${reason}`);
      return;
    }
    try {
      const existing = await repos.serviceIncident.findOpenForServer(target);
      const server = existing ? undefined : (await repos.server.getMany([target])).get(target);
      const transition = await recordServerUnreachable({
        organizationId,
        serverId: target,
        serverName: existing?.serviceName ?? server?.name ?? "this server",
        reason,
        affectedProjects: group.length,
        existing,
      });
      if (transition === "opened") summary.opened++;
    } catch (inner) {
      summary.errors++;
      console.error(`[health-watch] could not record unreachable server: ${safeErrorMessage(inner)}`);
    }
  } finally {
    // Tears down the SSH loopback bridge; a no-op on the socket transport. On a
    // deadline this is also what unwedges the transport — `withTimeout` races the
    // body, it cannot cancel it.
    try {
      await handle.runtime?.dispose?.();
    } catch (err) {
      // Deliberately NOT counted in `summary.errors`: a bridge that won't close is not a
      // failed observation, and reporting the sweep as failed would hide one that worked.
      // But it is the one failure in this file that LEAKS — an ssh child process and its
      // fd — and swallowed without a word it leaked once a minute with nothing to see.
      console.error(
        `[health-watch] ${serverId ?? "local docker"}: transport did not close cleanly: ${safeErrorMessage(err)}`,
      );
    }
  }
}

/**
 * Read one group and evaluate everything on it. Split out from `sweepServerGroup`
 * for one reason: it is the half that talks to a remote daemon, so it is the half
 * that needs a deadline around it.
 */
interface GroupHandle {
  runtime?: RuntimeAdapter;
  /** The container list came back — everything after this is not the daemon's fault. */
  listed?: boolean;
  /**
   * We stopped waiting for this group. Nothing still in flight inside it may write.
   *
   * `withTimeout` RACES the body — it cannot cancel it. So on a deadline the inspect
   * workers keep running, detached, outside the `sweepChain` that serializes ticks, and
   * every worker still queued behind the wedged inspect eventually wakes up in the middle
   * of a LATER tick to advance an agreement counter and open incidents for a group whose
   * verdict was already published as "the box didn't answer". Two observations of the
   * same stale sample, spaced far enough apart to look like agreement, is exactly the
   * false page `AGREE_TICKS` exists to prevent.
   */
  abandoned?: boolean;
}

async function readServerGroup(
  ctx: GroupContext,
  first: Candidate,
  target: {
    serverId: string | null;
    organizationId: string;
    handle: GroupHandle;
  },
): Promise<void> {
  const { group, summary } = ctx;
  const { serverId, organizationId, handle } = target;
  {
    // The READ-path resolver, not the full platform: building a platform runs the
    // OpenResty detect + edge Lua self-heal under the provision lock, which a
    // once-a-minute `docker ps` has no business contending with. It also picks the
    // right transport for us — local socket vs SSH bridge.
    //
    // The serverId is pinned from the GROUP rather than read off `first`. Both agree
    // today — `resolveWatchTargets` resolves by the same rules this resolver does — so
    // this is belt and braces, and it is the cheap direction: it makes the transport a
    // function of the group KEY instead of of whichever project happened to sort first,
    // which is the invariant every verdict in this group depends on.
    const resolved = await resolveDeploymentRuntimeForRead({
      meta: { ...((first.dep.meta ?? {}) as DeploymentMeta), serverId: serverId ?? undefined },
      organizationId,
    });
    handle.runtime = resolved.runtime;
    const runtime = resolved.runtime;
    if (!runtime.supports("hostContainerQuery") || !runtime.listAllContainers) return;

    const live = await runtime.listAllContainers();
    handle.listed = true;

    // The box answered — close its unreachable incident if it had one. Through the
    // same resolver the open path uses, so a LOCAL group can close the incident it
    // opened: that one hangs on the self-server row, which keying this off `serverId`
    // alone (null, here) could never reach.
    const incidentTarget = await incidentServerId(serverId, organizationId);
    if (incidentTarget) {
      const stale = await repos.serviceIncident.findOpenForServer(incidentTarget);
      if (stale && (await resolveServerIncident(stale))) summary.resolved++;
    }

    const byContainerId = new Map(live.map((c) => [c.id, c]));
    const sampler = runtime.supports("stabilityProbe") ? runtime.sampleStability?.bind(runtime) : undefined;
    let inspectBudget = MAX_INSPECTS_PER_SERVER;

    const pending: { candidate: Candidate; workload: Workload; container: ListedContainer | null }[] =
      [];
    for (const candidate of group) {
      summary.projects++;
      ctx.swept.add(candidate.project.id);
      let workloads: Workload[];
      try {
        workloads = await resolveWorkloads(candidate, ctx.serviceRows.get(candidate.project.id) ?? [], live);
      } catch (err) {
        summary.errors++;
        console.error(
          `[health-watch] ${candidate.project.slug}: could not resolve workloads: ${safeErrorMessage(err)}`,
        );
        // Not swept after all — don't let a failed read retire its incidents.
        ctx.swept.delete(candidate.project.id);
        continue;
      }
      summary.workloads += workloads.length;
      for (const workload of workloads) {
        pending.push({
          candidate,
          workload,
          container: byContainerId.get(workload.containerId) ?? null,
        });
      }
    }

    // Spend the inspect budget where it decides something. The container list already
    // proves a running container is running; what it cannot do is explain a container
    // that ISN'T — and an unexplained one gets `unknown`, which neither opens nor
    // closes anything. Evaluating in project order let the first 120 healthy
    // containers eat the budget and starve the one that was down, every tick, since
    // that order is stable. Hence: everything the list view can't explain goes first.
    pending.sort((a, b) => inspectRank(a.container) - inspectRank(b.container));

    await mapWithLimit(pending, INSPECT_CONCURRENCY, async ({ candidate, workload, container }) => {
      // `mapWithLimit` is pull-based: an item behind a wedged worker is picked up only
      // when that worker answers, which on a deadline is long after this group was
      // written off. Stopping here rather than at the write below is what keeps an
      // abandoned group from carrying on inspecting — up to `MAX_INSPECTS_PER_SERVER` of
      // them — against a box we just told the operator we cannot reach.
      if (handle.abandoned) return;
      const key = memoryKey(candidate.project.id, workload.serviceKey);
      ctx.visited.add(key);
      let sample: ContainerStabilitySample | null = null;
      if (container && sampler) {
        if (inspectBudget > 0) {
          inspectBudget--;
          try {
            sample = await sampler(workload.containerId);
          } catch {
            // An inspect that fails on a container the list view just showed is a
            // transient — treat it as no information, never as a fault. Counted,
            // because a box where this is the steady state is a box we are not
            // actually watching.
            summary.indeterminate++;
            return;
          }
        } else {
          // No budget. Left NULL on purpose rather than synthesized here:
          // `evaluate` already falls back to the list view for the verdict, and a
          // null sample is the only thing that tells it not to record the list
          // view's `restartCount: 0` as the restart baseline. Synthesizing here
          // would store 0, and the next observation that does get to inspect
          // would read the container's lifetime count as a one-minute delta — a
          // fabricated crash loop on a perfectly healthy service.
          summary.skipped++;
        }
      }

      // Checked again: the inspect that just answered may be the very one the deadline
      // gave up waiting for. `evaluate` is where every write lives, so this is the last
      // line at which a sample from a dead tick can be dropped instead of acted on.
      if (handle.abandoned) return;

      try {
        await evaluate({
          candidate,
          workload,
          key,
          sample,
          container,
          runtime,
          openByKey: ctx.openByKey,
          summary,
        });
      } catch (err) {
        // One workload's incident write rejecting (a service row deleted mid-sweep
        // takes its foreign key with it) says nothing about the box or about the
        // other workloads on it — and left to propagate it would abort this group and
        // come out of gate 3 as "can't reach Docker". MEMORY is written before any
        // of those statements run, so the agreement counter survives and the next
        // tick retries: the cost is one observation.
        summary.errors++;
        console.error(
          `[health-watch] ${candidate.project.slug}/${workload.serviceName}: ${safeErrorMessage(err)}`,
        );
      }
    });
  }
}

/** Inspect priority: 0 = the container list cannot explain this one, 1 = it can. */
function inspectRank(container: ListedContainer | null): number {
  // No container is no inspect to spend: `missingContainerVerdict` needs no sample.
  if (!container) return 1;
  return (container.state ?? "").toLowerCase().trim() === "running" ? 1 : 0;
}

/**
 * Which containers on this host does this project expect to be up?
 *
 * Compose/monorepo projects: one workload per service the ACTIVE release
 * deployed. Single-app projects: the deployment's own container.
 */
async function resolveWorkloads(
  candidate: Candidate,
  services: Service[],
  live: Parameters<typeof resolveLiveServiceState>[0]["live"],
): Promise<Workload[]> {
  const { project, dep, meta } = candidate;

  if (services.length === 0) {
    // Single-app. `runsAsContainer` is load-bearing: a bare deploy writes its
    // systemd handle into `containerId`, and inspecting that id would report a
    // missing container and page about a perfectly healthy service.
    if (!dep.containerId || !runsAsContainer(meta)) return [];
    return [
      {
        serviceId: null,
        serviceKey: SINGLE_APP_KEY,
        serviceName: project.name,
        containerId: dep.containerId,
        expectRunning: true,
      },
    ];
  }

  const hints = new Map(
    (await repos.service.listByDeployment(dep.id)).map((row) => [row.serviceId, row]),
  );
  const matches = resolveLiveServiceState({
    services: services.map((s) => ({ id: s.id, name: s.name })),
    live,
    projectId: project.id,
    slug: project.slug,
    trackedIds: Object.fromEntries([...hints].map(([id, row]) => [id, row.containerId])),
  });

  const workloads: Workload[] = [];
  for (const service of services) {
    const hint = hints.get(service.id);
    // Not part of the active release (added but never deployed, or skipped).
    if (!hint) continue;
    const containerId = matches.get(service.id)?.containerId ?? hint.containerId;
    if (!containerId) continue;
    workloads.push({
      serviceId: service.id,
      serviceKey: service.id,
      serviceName: service.name,
      containerId,
      // Gate 2. `service_deployment.status` is never read for LIVENESS — but it
      // is the only record of INTENT, written by stopServiceContainer.
      expectRunning: service.enabled !== false && hint.status !== "stopped",
    });
  }
  return workloads;
}

/**
 * Synthesize a sample from the container LIST when there is no inspect to work
 * from — the runtime exposes no stability probe, or this server's inspect budget
 * ran out. Called from exactly one place (`evaluate`) so the two reasons cannot
 * drift apart.
 *
 * Deliberately reports `restartCount: 0` and no restart policy: the list view
 * cannot see either, and inventing a value would either fabricate a crash loop or
 * silently reclassify an exit. The 0 is safe to CLASSIFY on (a delta needs a
 * baseline, and there is none) but never safe to STORE as one — see `evaluate`.
 * The one thing it can prove — the state, and the `(unhealthy)` suffix Docker
 * writes into the status line — is enough for the down/unhealthy verdicts.
 */
const KNOWN_STATES: ReadonlySet<string> = new Set([
  "created",
  "running",
  "restarting",
  "paused",
  "exited",
  "dead",
  "removing",
]);

function sampleFromListView(container: ListedContainer): ContainerStabilitySample {
  const state = (container.state ?? "").toLowerCase().trim();
  return {
    state: KNOWN_STATES.has(state) ? (state as ContainerStabilitySample["state"]) : "unknown",
    exitCode: null,
    restartCount: 0,
    // `liveContainerStatus` is the one parser for the `(unhealthy)` suffix docker
    // writes into the human status line — reimplementing it here is how the badge
    // and the alert would come to disagree.
    health: state === "running" && liveContainerStatus(container) === "failed" ? "unhealthy" : null,
    errorLine: null,
    oomKilled: false,
    // Unknown, not "no". Combined with the null exit code above, a container that
    // is not running gets the classifier's `unknown` clear: it reports no fault, and
    // — the part that matters — it does not RESOLVE one either.
    restartPolicy: null,
  };
}

/**
 * What restart baseline does this observation diff against, and what does it
 * leave behind for the next one?
 *
 * `observed` is the RAW inspect count only — a list-view fallback reports 0, and
 * anchoring on that would manufacture a +N delta (a fabricated crash loop) on the
 * next observation that does get to inspect. A null observation therefore leaves
 * the existing anchor exactly as it was: no inspect is no information, which is
 * not the same as a reason to forget.
 */
function resolveRestartBaseline(args: {
  previous: WatchMemory | undefined;
  sameContainer: boolean;
  observed: number | null;
  nowMs: number;
}): { prev: number | null; ageMs: number | undefined; count: number | null; atMs: number } {
  const { previous, sameContainer, observed, nowMs } = args;
  const fresh = { prev: null, ageMs: undefined, count: observed, atMs: nowMs };
  // A recreated container's counter restarted at 0; diffing across that reads as a
  // negative delta, so the recreate always starts over.
  if (!sameContainer || !previous || previous.restartCount === null) return fresh;

  const ageMs = nowMs - previous.restartCountAtMs;
  const usable = ageMs <= RESTART_STALE_MS;
  const carry = { prev: usable ? previous.restartCount : null, ageMs: usable ? ageMs : undefined };
  // Hold the anchor while it is young (accumulate) or while we learned nothing new.
  const hold = observed === null || ageMs < RESTART_WINDOW_MS;
  return hold
    ? { ...carry, count: previous.restartCount, atMs: previous.restartCountAtMs }
    : { ...carry, count: observed, atMs: nowMs };
}

/**
 * Turn one observation into an incident transition.
 *
 * The confirmation counter lives here rather than in the classifier because it is
 * a policy about NOTIFYING, not about what a sample means: `AGREE_TICKS` is what
 * separates "docker was mid-restart when we happened to look" from "this is
 * broken".
 */
async function evaluate(args: {
  candidate: Candidate;
  workload: Workload;
  key: string;
  sample: ContainerStabilitySample | null;
  container: ListedContainer | null;
  runtime: RuntimeAdapter;
  openByKey: Map<string, ServiceIncident>;
  summary: HealthWatchSummary;
}): Promise<void> {
  const { candidate, workload, key, container, summary } = args;
  const previous = MEMORY.get(key);
  const sameContainer = previous?.containerId === workload.containerId;
  const existing = args.openByKey.get(key);
  // No inspect (no probe capability, or the budget ran out) still leaves what the
  // container list itself proved.
  const sample = args.sample ?? (container ? sampleFromListView(container) : null);

  const nowMs = Date.now();
  const baseline = resolveRestartBaseline({
    previous,
    sameContainer,
    observed: args.sample?.restartCount ?? null,
    nowMs,
  });

  const verdict =
    container && sample
      ? classifySteadyState(sample, {
          prevRestartCount: baseline.prev,
          baselineAgeMs: baseline.ageMs,
          expectRunning: workload.expectRunning,
          createdTicks: sameContainer ? (previous?.createdTicks ?? 0) : 0,
        })
      : missingContainerVerdict(workload);

  // An observation that could not answer is not an observation. Any open incident
  // stays exactly where it is — the same call the sweep makes for a box that didn't
  // answer — and MEMORY keeps the agreement counter and restart baseline it already
  // had, because forgetting a fault that was one observation from confirmed costs a
  // detection it had already half-earned.
  if (verdict.clear === "unknown") {
    summary.indeterminate++;
    const carried: WatchMemory =
      previous && sameContainer
        ? previous
        : {
            containerId: workload.containerId,
            restartCount: baseline.count,
            restartCountAtMs: baseline.atMs,
            kind: null,
            agreed: 0,
            lastSeenAtMs: nowMs,
            createdTicks: 0,
            healthySince: null,
            lastResolvedAtMs: previous?.lastResolvedAtMs ?? null,
          };
    MEMORY.set(key, {
      ...carried,
      containerId: workload.containerId,
      // The one thing a `created` sample does establish. Two consecutive ticks of it
      // is the "created but never started" rule, so this counter has to survive an
      // otherwise-uninformative observation or that rule can never fire.
      createdTicks:
        sample?.state === "created" ? (sameContainer ? (previous?.createdTicks ?? 0) + 1 : 1) : 0,
    });
    return;
  }

  // Does this observation ADVANCE the agreement, or only repeat it? A repeat of
  // the same fault on the same container counts once per MIN_CONFIRM_GAP_MS; the
  // 60s poll clears that trivially, an event burst does not.
  const repeat = Boolean(verdict.kind) && sameContainer && previous?.kind === verdict.kind;
  const held = repeat && nowMs - (previous?.lastSeenAtMs ?? 0) < MIN_CONFIRM_GAP_MS;
  const agreed = !verdict.kind ? 0 : repeat ? (held ? previous!.agreed : previous!.agreed + 1) : 1;

  const memory: WatchMemory = {
    containerId: workload.containerId,
    restartCount: baseline.count,
    restartCountAtMs: baseline.atMs,
    kind: verdict.kind,
    agreed,
    lastSeenAtMs: held ? previous!.lastSeenAtMs : nowMs,
    createdTicks:
      sample?.state === "created" ? (sameContainer ? (previous?.createdTicks ?? 0) + 1 : 1) : 0,
    // A run of health continues across a recreate: this asks whether the WORKLOAD
    // has been fine, and a container that came back up healthy has been.
    healthySince: verdict.kind ? null : (previous?.kind === null ? (previous.healthySince ?? nowMs) : nowMs),
    lastResolvedAtMs: previous?.lastResolvedAtMs ?? null,
  };
  MEMORY.set(key, memory);

  if (!verdict.kind) {
    if (!existing) return;
    // Down on purpose — stopped, disabled, or paused. Closed the same way the reap
    // below closes a workload that stopped being watched: the row goes away, nothing
    // is announced. "is back up" about a service somebody deliberately switched off
    // is the notification that teaches an operator to ignore this channel.
    //
    // `lastResolvedAtMs` is deliberately NOT stamped: an operator stop-then-start is
    // not a flap, and damping the NEXT real fault behind `RECOVERY_HOLD_MS` because
    // of it would delay a genuine page.
    if (verdict.clear === "not_expected") {
      if (await repos.serviceIncident.resolve(existing.id)) {
        summary.stale++;
        args.openByKey.delete(key);
      }
      return;
    }
    // Healthy, with an incident to close. Normally that happens on this one good
    // observation. The exception is a workload we have already watched break right
    // after a recovery — see `RECOVERY_HOLD_MS`. Re-breaking inside the hold leaves
    // the SAME incident open, so the whole episode stays one alert instead of one
    // per cycle.
    const flapping =
      memory.lastResolvedAtMs !== null &&
      existing.openedAt.getTime() - memory.lastResolvedAtMs < FLAP_WINDOW_MS;
    if (flapping && nowMs - (memory.healthySince ?? nowMs) < RECOVERY_HOLD_MS) {
      summary.recovering++;
      return;
    }
    if (await resolveWorkloadIncident(existing, candidate.project.name)) {
      summary.resolved++;
      memory.lastResolvedAtMs = nowMs;
      args.openByKey.delete(key);
    }
    return;
  }

  if (agreed < AGREE_TICKS) {
    // Seen, unconfirmed: the accelerator turns this into one follow-up observation
    // (an out-of-band run only ever produces one, and one confirms nothing).
    summary.pending++;
    // If an incident is already open (this is a flap to a different kind
    // mid-outage) keep its detail current without notifying. Skipped for a held
    // observation — that one carries no new information, and counting it would
    // inflate `confirmations` by however many events the burst happened to carry.
    if (existing && !held) {
      await repos.serviceIncident.touch(existing.id, {
        reason: verdict.reason,
        exitCode: sample?.exitCode ?? null,
        restartCount: sample?.restartCount ?? existing.restartCount,
        containerId: workload.containerId,
      });
    }
    return;
  }

  const target: WorkloadTarget = {
    organizationId: candidate.dep.organizationId,
    projectId: candidate.project.id,
    projectName: candidate.project.name,
    serviceId: workload.serviceId,
    serviceKey: workload.serviceKey,
    serviceName: workload.serviceName,
    serverId: candidate.serverId,
    containerId: workload.containerId,
  };

  // Read the log tail ONLY when this will produce a message. Otherwise a box full
  // of crash-looping containers costs one `docker logs` per container per minute
  // for text nobody receives.
  const logExcerpt =
    container && willNotifyFor(existing, verdict.kind)
      ? (await readLogTail(args.runtime, workload.containerId, LOG_TAIL_LINES)).join("\n") || null
      : null;

  const transition = await recordWorkloadFailure(
    target,
    {
      kind: verdict.kind,
      reason: verdict.reason,
      exitCode: sample?.exitCode ?? null,
      restartCount: sample?.restartCount ?? 0,
      oomKilled: sample?.oomKilled ?? false,
      logExcerpt,
    },
    existing,
  );
  if (transition === "opened") summary.opened++;
  else if (transition === "escalated") summary.escalated++;
}

/**
 * The container isn't on the host at all.
 *
 * `classifySteadyState` deliberately refuses to call this: absent is
 * indistinguishable from mid-recreate, and only the sweep knows a deploy isn't
 * running (gate 1 already excluded that). Without this verdict a container deleted
 * out of band would read as healthy and RESOLVE an open incident.
 */
function missingContainerVerdict(workload: Workload): SteadyStateVerdict {
  if (!workload.expectRunning) return { kind: null, reason: "", clear: "not_expected" };
  return { kind: "down", reason: "its container no longer exists on the host" };
}

/** Retention for resolved incident history. Open incidents are never pruned. */
export const INCIDENT_RETENTION_DAYS = 30;

export async function pruneResolvedIncidents(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - INCIDENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return { deleted: await repos.serviceIncident.deleteResolvedOlderThan(cutoff) };
}
