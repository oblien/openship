/**
 * Docker events as an ACCELERATOR for the container health watch.
 *
 * The health watch (`health-watch.ts`) polls every server once a minute, which
 * means a container that dies at 3am pages up to ~90s later (a fault must be seen
 * twice). The daemon already knows the instant it happened, so we listen — and
 * turn a transition into "sweep that one box now".
 *
 * ── What this module deliberately does NOT do ─────────────────────────────────
 * It never classifies anything. An event carries no state (`die` is emitted by a
 * crash, by `docker stop`, and by every redeploy alike), so deciding from one
 * would mean a second copy of the sweep's four suppression gates, drifting from
 * the first. Instead an event only ever calls `runHealthWatch({onlyServerKeys})`.
 * Every gate, every classifier, every dedup rule stays in exactly one place, and
 * the worst a spurious event can cost is one extra `docker ps -a`.
 *
 * It also never becomes the source of truth. The stream is edge-triggered: a
 * dropped connection or a daemon restart loses transitions permanently, and a
 * container stuck in `created` — or already down before we connected — never
 * emits one at all. That is why the poll stays, and why every (re)connect is
 * itself a reason to sweep.
 *
 * ── Lifecycle is a lease, renewed by the poll ─────────────────────────────────
 * `renewEventWatchers()` is called at the end of each FULL sweep with the groups
 * that sweep enumerated. Each renewal arms a timer for `LEASE_MS`, and a lease
 * nobody renews expires ITSELF — deliberately not "checked on the next sweep",
 * because the case that matters most is the one where there is no next sweep. One
 * mechanism buys all of:
 *   - no startup hook — the first tick after boot subscribes;
 *   - turning the health-watch job off drains every stream within ~2.5 min, so it
 *     really is off: an expired subscription still receiving events would keep
 *     calling the sweep out of band, and keep notifying, with the job disabled;
 *   - a box whose last project is deleted, disabled, or moved to cloud loses its
 *     subscription on its own;
 *   - the accelerator structurally cannot outlive the sweep it accelerates.
 *
 * ── The connection inversion ──────────────────────────────────────────────────
 * The sweep opens a runtime per tick and disposes it in a `finally`. These
 * runtimes are held OPEN — one long-lived loopback bridge per remote box — so the
 * SSH connection is `retain()`ed against the pool's idle drop and released on
 * every close path. A credential change invalidates it out from under us, which
 * surfaces as `onClose` and reconnects with the new credentials.
 */

import { safeErrorMessage } from "@repo/core";
import {
  getPlatform,
  type ContainerLifecycleEvent,
  type RuntimeAdapter,
} from "@repo/adapters";
import { env } from "../../config/env";
import { resolveDeploymentRuntimeForRead } from "../../lib/deployment-runtime";
import { sshManager } from "../../lib/ssh-manager";
import { parseWatchGroupKey, runHealthWatch } from "./health-watch";

/**
 * How long one `renewEventWatchers` call vouches for a group. Comfortably more
 * than two poll intervals: a group legitimately disappears for a tick or two
 * (gate 1 skips a project while its deploy is in flight), and tearing the stream
 * down and rebuilding it — an SSH bridge, for a remote box — on that churn would
 * cost more than the idle stream does.
 */
const LEASE_MS = 150_000;
/**
 * Events arrive in bursts — a single `docker stop` emits `kill`+`die`+`stop`, a
 * redeploy emits four per container. One sweep answers all of them. The wait also
 * lets an intentional stop's `service_deployment.status='stopped'` write land
 * before the sweep reads intent, so gate 2 sees it.
 */
const DEBOUNCE_MS = 3_000;
/**
 * An out-of-band sweep is ONE observation, and one confirms nothing (`AGREE_TICKS`
 * is 2). When it reports an unconfirmed fault we take the second observation
 * ourselves rather than waiting for the next scheduled tick — that is the whole
 * ~90s → ~10s win. Must exceed the sweep's `MIN_CONFIRM_GAP_MS` (4s) or the
 * second observation would be held rather than counted.
 */
const FOLLOW_UP_MS = 6_000;
/** Follow-ups per burst. Beyond this the scheduled poll can have it. */
const MAX_FOLLOW_UPS = 2;
/**
 * Floor between out-of-band sweeps of the SAME group. A crash-looping container
 * (or a busy box running CI) emits events continuously; without this we would
 * hammer its daemon. Worst case is ~6 sweeps/min for one box instead of 1.
 *
 * Measured from when a run FINISHES, not when it was queued. Every entry point
 * serializes on the sweep's own chain, so a run enqueued behind a slow box has not
 * read anything yet — stamping it as "the last run" let the floor elapse while
 * nothing had happened, and each subsequent event appended another run for the
 * same box. They then drained as a burst of identical `docker ps -a` reads, all
 * answerable by one, with the next scheduled full sweep stuck behind them. Paired
 * with `running`/`rearm` below, at most one out-of-band run per group is ever
 * outstanding, which is what makes the ~6/min above a real ceiling.
 */
const MIN_RUN_GAP_MS = 10_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

interface Subscription {
  key: string;
  serverId: string | null;
  organizationId: string;
  /** Held for the subscription's whole life — not disposed per sweep. */
  runtime: RuntimeAdapter | null;
  stopStream: (() => void) | null;
  /** True while the SSH hold is ours to release. */
  retained: boolean;
  leaseUntil: number;
  /** Fires at `leaseUntil`; re-armed by every renewal. See `armLease`. */
  expiry: ReturnType<typeof setTimeout> | null;
  /** A connect attempt is in flight; renewal must not start a second one. */
  connecting: boolean;
  /** Closed for good — late callbacks from a dead stream are ignored. */
  closed: boolean;
  debounce: ReturnType<typeof setTimeout> | null;
  reconnect: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  followUpsLeft: number;
  /** A sweep for this group is queued or executing — see `MIN_RUN_GAP_MS`. */
  running: boolean;
  /** An event landed while one was running; schedule exactly one more when it ends. */
  rearm: boolean;
  /** When the last run FINISHED. */
  lastRunAt: number;
}

const SUBS = new Map<string, Subscription>();

/** Timers must never be the reason the process can't exit. */
function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

function eventsEnabled(): boolean {
  // Same gate as the health-watch job itself: desktop has no always-on poller and
  // Oblien exposes no event feed, so "selfhosted" is the only target with anything
  // to accelerate.
  return getPlatform().target === "selfhosted" && !env.OPENSHIP_DISABLE_CONTAINER_EVENTS;
}

/**
 * Called by `runHealthWatch` at the end of every full sweep with the group keys it
 * enumerated. Returns without waiting on connects: subscribing to a remote box
 * stands up an SSH bridge, and the poll tick must not pay for that.
 */
export async function renewEventWatchers(groupKeys: readonly string[]): Promise<void> {
  if (!eventsEnabled()) {
    if (SUBS.size > 0) await stopAllContainerEventWatchers();
    return;
  }

  for (const key of groupKeys) {
    const existing = SUBS.get(key);
    if (existing) {
      armLease(existing);
      continue;
    }
    const { serverId, organizationId } = parseWatchGroupKey(key);
    if (!organizationId) continue;
    const sub: Subscription = {
      key,
      serverId,
      organizationId,
      runtime: null,
      stopStream: null,
      retained: false,
      leaseUntil: 0,
      expiry: null,
      connecting: false,
      closed: false,
      debounce: null,
      reconnect: null,
      backoffMs: RECONNECT_MIN_MS,
      followUpsLeft: MAX_FOLLOW_UPS,
      running: false,
      rearm: false,
      lastRunAt: 0,
    };
    armLease(sub);
    SUBS.set(key, sub);
    void connect(sub);
  }
}

/**
 * (Re)start this subscription's lease.
 *
 * The timer is what makes the lease real. Expiring only inside
 * `renewEventWatchers` meant the lease was checked exactly when a full sweep ran —
 * so the one scenario it is most needed for, the health-watch job being turned
 * off, was the one where nothing ever checked it. Streams stayed open and kept
 * calling the sweep (and notifying) out of band, indefinitely.
 */
function armLease(sub: Subscription): void {
  sub.leaseUntil = Date.now() + LEASE_MS;
  if (sub.expiry) clearTimeout(sub.expiry);
  sub.expiry = unref(
    setTimeout(() => {
      sub.expiry = null;
      void teardown(sub, "lease expired");
    }, LEASE_MS),
  );
}

/** Shutdown: drop every stream and hand its SSH connection back to the pool. */
export async function stopAllContainerEventWatchers(): Promise<void> {
  for (const sub of [...SUBS.values()]) await teardown(sub, "shutdown");
}

async function connect(sub: Subscription): Promise<void> {
  if (sub.closed || sub.connecting || sub.stopStream) return;
  sub.connecting = true;
  try {
    // The same read-path resolver the sweep uses, so the transport decision (local
    // socket vs SSH bridge) is made in exactly one place. Re-resolved on every
    // reconnect, which is how a credential change is picked up.
    const { runtime } = await resolveDeploymentRuntimeForRead({
      meta: { serverId: sub.serverId ?? undefined },
      organizationId: sub.organizationId,
    });
    if (sub.closed) {
      await disposeRuntime(runtime, sub.key);
      return;
    }
    if (!runtime.supports("containerEvents") || !runtime.watchContainerEvents) {
      // Drop the subscription rather than reconnect-looping against a runtime that
      // will never stream. The next full sweep re-probes, which costs one resolve +
      // dispose a minute — acceptable because it is unreachable in practice:
      // `resolveDeploymentRuntimeForRead` pins `runtimeMode: "docker"` (a bare
      // project's sidecars are still containers), and the Docker runtime declares
      // the capability. This is the guard for a future non-Docker read runtime.
      await disposeRuntime(runtime, sub.key);
      sub.closed = true;
      SUBS.delete(sub.key);
      return;
    }

    if (sub.serverId) {
      sshManager.retain(sub.serverId);
      sub.retained = true;
    }
    sub.runtime = runtime;
    sub.stopStream = await runtime.watchContainerEvents({
      onEvent: (event) => onEvent(sub, event),
      onClose: (err) => void onClose(sub, err),
    });
    sub.backoffMs = RECONNECT_MIN_MS;

    // A (re)connect is itself a reason to read state: whatever changed while we
    // were not listening has no event left to replay.
    schedule(sub);
  } catch (err) {
    await onClose(sub, err instanceof Error ? err : new Error(safeErrorMessage(err)));
  } finally {
    sub.connecting = false;
  }
}

function onEvent(sub: Subscription, _event: ContainerLifecycleEvent): void {
  // The event's action and container id are deliberately unused: the sweep re-reads
  // the state of everything on this box anyway, and an event for a container no
  // project of ours owns still means the daemon is answering, which costs one
  // `docker ps -a`. Filtering here would need a container→workload index that
  // duplicates `resolveWorkloads`.
  //
  // An event arriving a full floor-interval after the last run is a NEW burst, not
  // the tail of the one we're still following up on — only then does the follow-up
  // budget reset, which is what bounds a permanently-flapping box.
  if (Date.now() - sub.lastRunAt >= MIN_RUN_GAP_MS) sub.followUpsLeft = MAX_FOLLOW_UPS;
  schedule(sub);
}

async function onClose(sub: Subscription, err: Error | null): Promise<void> {
  if (sub.closed) return;
  await releaseTransport(sub);
  if (err) {
    console.warn(`[container-events] ${sub.key} stream closed: ${safeErrorMessage(err)}`);
  }
  // Lease already gone, or the feature was turned off mid-stream: don't reconnect.
  if (sub.leaseUntil <= Date.now() || !eventsEnabled()) {
    sub.closed = true;
    SUBS.delete(sub.key);
    return;
  }
  const delay = sub.backoffMs;
  sub.backoffMs = Math.min(sub.backoffMs * 2, RECONNECT_MAX_MS);
  if (sub.reconnect) clearTimeout(sub.reconnect);
  sub.reconnect = unref(
    setTimeout(() => {
      sub.reconnect = null;
      void connect(sub);
    }, delay),
  );
}

/**
 * Coalesce a burst into one sweep. Event- and connect-driven runs are held to the
 * per-group floor; a follow-up is not — it is the second half of an observation
 * pair, already capped by `MAX_FOLLOW_UPS`, and delaying it to the floor would give
 * back most of the latency this module exists to win.
 */
function schedule(sub: Subscription, opts?: { delayMs: number; enforceFloor: boolean }): void {
  if (sub.closed || sub.debounce) return;
  // A run is already queued or executing. It will re-read the whole box anyway, so
  // remember that something arrived and schedule ONE more when it lands, rather
  // than appending another identical read to the sweep's serialized chain.
  if (sub.running) {
    sub.rearm = true;
    return;
  }
  const delayMs = opts?.delayMs ?? DEBOUNCE_MS;
  const enforceFloor = opts?.enforceFloor ?? true;
  const wait = enforceFloor
    ? Math.max(delayMs, MIN_RUN_GAP_MS - (Date.now() - sub.lastRunAt))
    : delayMs;
  sub.debounce = unref(
    setTimeout(() => {
      sub.debounce = null;
      void sweep(sub);
    }, wait),
  );
}

async function sweep(sub: Subscription): Promise<void> {
  if (sub.closed || sub.running) return;
  sub.running = true;
  let followUp = false;
  try {
    const summary = await runHealthWatch({ onlyServerKeys: new Set([sub.key]) });
    if (summary.pending > 0 && sub.followUpsLeft > 0) {
      sub.followUpsLeft--;
      followUp = true;
    } else {
      // Nothing left hanging — the next burst gets a fresh follow-up budget.
      sub.followUpsLeft = MAX_FOLLOW_UPS;
    }
  } catch (err) {
    // runHealthWatch swallows its own failures; this only catches the unexpected.
    console.error(`[container-events] ${sub.key} sweep failed: ${safeErrorMessage(err)}`);
  } finally {
    sub.lastRunAt = Date.now();
    sub.running = false;
    // A follow-up is a sweep of this same group, so it already covers whatever
    // arrived mid-run; only fall back to `rearm` when there is no follow-up.
    const rearm = sub.rearm;
    sub.rearm = false;
    if (sub.closed) {
      /* teardown already released everything — scheduling now would resurrect it */
    } else if (followUp) {
      schedule(sub, { delayMs: FOLLOW_UP_MS, enforceFloor: false });
    } else if (rearm) {
      schedule(sub);
    }
  }
}

/** Drop the stream + runtime + SSH hold, leaving the subscription reconnectable. */
async function releaseTransport(sub: Subscription): Promise<void> {
  const stop = sub.stopStream;
  sub.stopStream = null;
  try {
    stop?.();
  } catch (err) {
    // Logged, not rethrown: the SSH hold below is released in the same breath, and
    // stranding it would leak a pooled connection for a stream that was already going
    // away. But an aborter that throws every reconnect is a leak of its own.
    console.error(`[container-events] ${sub.key} stream would not close: ${safeErrorMessage(err)}`);
  }
  const runtime = sub.runtime;
  sub.runtime = null;
  await disposeRuntime(runtime, sub.key);
  if (sub.retained && sub.serverId) {
    sub.retained = false;
    sshManager.release(sub.serverId);
  }
}

async function teardown(sub: Subscription, reason: string): Promise<void> {
  if (sub.closed) return;
  sub.closed = true;
  SUBS.delete(sub.key);
  if (sub.debounce) clearTimeout(sub.debounce);
  if (sub.reconnect) clearTimeout(sub.reconnect);
  if (sub.expiry) clearTimeout(sub.expiry);
  sub.debounce = null;
  sub.reconnect = null;
  sub.expiry = null;
  await releaseTransport(sub);
  console.log(`[container-events] ${sub.key} unsubscribed (${reason})`);
}

async function disposeRuntime(runtime: RuntimeAdapter | null, key: string): Promise<void> {
  try {
    await runtime?.dispose?.();
  } catch (err) {
    // A bridge that won't close cleanly must not break the teardown chain — the SSH
    // release is the next statement at every call site. It does leak an ssh child and
    // its fd though, so it says so: a reconnect loop over a transport that never
    // disposes is otherwise invisible until the process runs out of descriptors.
    console.error(`[container-events] ${key} transport did not close cleanly: ${safeErrorMessage(err)}`);
  }
}

/** Test seam: subscriptions are module state, and each test needs a clean slate. */
export function __resetContainerEventWatchers(): void {
  for (const sub of SUBS.values()) {
    sub.closed = true;
    if (sub.debounce) clearTimeout(sub.debounce);
    if (sub.reconnect) clearTimeout(sub.reconnect);
    if (sub.expiry) clearTimeout(sub.expiry);
  }
  SUBS.clear();
}
