/**
 * Post-start stabilization: did the workload we just created actually STAY up?
 *
 * Creating a container is not evidence that it runs. A bad start command, a
 * missing env var, or an unbindable port exits within milliseconds — and because
 * production containers carry `restart: always`, docker immediately restarts
 * them, so `docker ps` shows "Up 1 second" forever and every point-in-time read
 * (including `getContainerInfo`, which deliberately collapses `restarting` into
 * `running`) reports a healthy service. That is how a deploy reported `ready`
 * with `successfulServices: 1` while the single service was crash-looping.
 *
 * So the deploy watches instead of glancing: poll the runtime for a short window
 * and judge the SERIES, not one sample.
 *
 *   crash loop  — restarts kept accumulating (>= crashRestarts) while we watched
 *   exited      — it is down for good with a non-zero exit code
 *   unhealthy   — its own compose `healthcheck` block says so
 *   completed   — exited 0 and its restart policy leaves it stopped: a one-shot
 *                 job that did its work, not a failure
 *   stable      — stayed up for the whole window (with a warning when it
 *                 restarted once or twice first — usually a dependency wait)
 *
 * Callers credit time a container has ALREADY been up (`alreadyRunningMs`), so a
 * whole stack costs one window rather than one per service.
 */

/** One inspect reading, normalized away from any one runtime's field names. */
export interface ContainerStabilitySample {
  /** Docker's `State.Status`; "missing" when the container is gone entirely. */
  state:
    | "created"
    | "running"
    | "restarting"
    | "paused"
    | "exited"
    | "dead"
    | "removing"
    | "missing"
    | "unknown";
  /** Exit code of the LAST exit; null while it has never exited. */
  exitCode: number | null;
  /** Docker's `RestartCount` — monotonic per container, so a rising value is a loop. */
  restartCount: number;
  /** The container's own healthcheck verdict; null when it declares none. */
  health: "starting" | "healthy" | "unhealthy" | null;
  /** `State.Error` — set for OOM / OCI start failures. */
  errorLine: string | null;
  oomKilled: boolean;
  /** `HostConfig.RestartPolicy.Name` — "" / "no" means nothing will restart it. */
  restartPolicy: string | null;
}

export type StabilityStatus =
  | "stable"
  | "completed"
  | "crash_loop"
  | "exited"
  | "unhealthy"
  | "dead"
  | "missing";

export interface StabilityVerdict {
  status: StabilityStatus;
  /** True for `stable` and `completed` — everything else failed the window. */
  ok: boolean;
  /** One line, already phrased for an operator (no exception text). */
  reason: string;
  /** Non-fatal note on an `ok` verdict (e.g. it restarted twice, then settled). */
  warning?: string;
  exitCode?: number | null;
  restarts?: number;
  oomKilled?: boolean;
}

export interface StabilityOptions {
  /** Total observation window in ms. */
  windowMs: number;
  /** Poll interval in ms. */
  pollMs: number;
  /** Restarts within the window that count as a crash loop. */
  crashRestarts: number;
  /**
   * How long the CALLER has already known this container to be up, measured on
   * the caller's clock — credited against the window, so in a multi-service
   * deploy only the youngest container still owes it any time.
   *
   * Deliberately not derived from the container's own `StartedAt`: that timestamp
   * comes from the target host's clock, and a remote box running a minute behind
   * would read as "already up long enough" and skip the watch entirely.
   */
  alreadyRunningMs?: number;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * What the restart policy does with an exit, which decides whether "exited" is a
 * verdict or just the trough of a bounce. `always`/`unless-stopped` restart on
 * ANY exit; `on-failure` only on a non-zero one; `no`/unset never.
 *
 * Exported because the steady-state health watch asks the same question of a
 * container that has been running for days, and the answer must not drift between
 * "did this deploy work" and "is this still up".
 */
export function restartsAfter(policy: string | null, exitCode: number): boolean {
  const p = (policy ?? "").trim().toLowerCase();
  if (p === "always" || p === "unless-stopped") return true;
  if (p === "on-failure") return exitCode !== 0;
  return false;
}

/**
 * Judge the series so far. Returns a verdict once the outcome is settled, or
 * null while the answer still depends on what happens next.
 *
 * Pure — the caller owns the clock and the sampling. `first` is the baseline
 * reading (its restartCount is the zero point: a container may already have
 * restarted while LATER services in the same stack were being created).
 */
export function classifyStability(
  first: ContainerStabilitySample,
  latest: ContainerStabilitySample,
  opts: StabilityOptions & { windowElapsed: boolean },
): StabilityVerdict | null {
  const restarts = Math.max(0, latest.restartCount - first.restartCount);
  const detail = latest.errorLine?.trim() ? ` (${latest.errorLine.trim()})` : "";

  if (latest.state === "missing") {
    return {
      status: "missing",
      ok: false,
      reason: "the container disappeared moments after it was created",
      restarts,
    };
  }

  if (latest.state === "dead") {
    return {
      status: "dead",
      ok: false,
      reason: `the container is in docker's "dead" state${detail}`,
      exitCode: latest.exitCode,
      restarts,
      oomKilled: latest.oomKilled,
    };
  }

  // A crash loop is the whole point of watching: restarts keep landing, so no
  // single sample ever looks broken. Decide as soon as the count proves it.
  if (restarts >= opts.crashRestarts) {
    return {
      status: "crash_loop",
      ok: false,
      reason:
        `it restarted ${plural(restarts, "time")} in the first ` +
        `${Math.round(opts.windowMs / 1000)}s — the process exits right after start` +
        `${latest.exitCode !== null ? ` (exit code ${latest.exitCode})` : ""}${detail}`,
      exitCode: latest.exitCode,
      restarts,
      oomKilled: latest.oomKilled,
    };
  }

  // Down. Conclusive only when nothing will bring it back; otherwise this is one
  // trough of a bounce, and the restart-count rule above owns that call.
  if (latest.state === "exited") {
    const code = latest.exitCode ?? 0;
    if (!restartsAfter(latest.restartPolicy, code)) {
      if (code === 0) {
        return {
          status: "completed",
          ok: true,
          reason: "it ran to completion (exit code 0) and its restart policy leaves it stopped",
          exitCode: 0,
          restarts,
        };
      }
      return {
        status: "exited",
        ok: false,
        reason: `it exited with code ${code} and will not be restarted${detail}`,
        exitCode: code,
        restarts,
        oomKilled: latest.oomKilled,
      };
    }
    if (opts.windowElapsed) {
      return {
        status: code === 0 ? "crash_loop" : "exited",
        ok: false,
        reason:
          code === 0
            ? `it keeps exiting (code 0) and being restarted${detail}`
            : `it exited with code ${code} and is still down at the end of the window${detail}`,
        exitCode: code,
        restarts,
        oomKilled: latest.oomKilled,
      };
    }
    return null;
  }

  // The container's own healthcheck failing is a first-class answer.
  if (latest.health === "unhealthy") {
    return {
      status: "unhealthy",
      ok: false,
      reason: `its healthcheck reports unhealthy${detail}`,
      exitCode: latest.exitCode,
      restarts,
    };
  }

  if (!opts.windowElapsed) {
    // Passing early is only safe when the container itself vouches for readiness
    // AND it has not been bouncing.
    if (latest.health === "healthy" && restarts === 0 && latest.state === "running") {
      return { status: "stable", ok: true, reason: "healthcheck passed", restarts: 0 };
    }
    return null;
  }

  // ── Deadline reached ──────────────────────────────────────────────────
  if (latest.state !== "running") {
    // `restarting` / `created` (never started) / `removing` / `paused` — whatever
    // it is at the deadline, it isn't serving.
    return {
      status: latest.state === "restarting" ? "crash_loop" : "exited",
      ok: false,
      reason: `it is still "${latest.state}" ${Math.round(opts.windowMs / 1000)}s after start${detail}`,
      exitCode: latest.exitCode,
      restarts,
      oomKilled: latest.oomKilled,
    };
  }

  // Running at the deadline. A restart or two on the way up is normal for a
  // service that waits on a database, so it passes — with the count surfaced,
  // because it is exactly what an operator wants to know when the app is flaky.
  const notes = [
    ...(restarts > 0
      ? [`restarted ${plural(restarts, "time")} during startup before settling`]
      : []),
    ...(latest.health === "starting" ? ["healthcheck has not reported healthy yet"] : []),
  ];
  return {
    status: "stable",
    ok: true,
    reason: "stayed up for the whole stabilization window",
    restarts,
    ...(notes.length ? { warning: notes.join("; ") } : {}),
  };
}

export interface WatchStabilityDeps {
  /** One inspect reading. Return a `missing` sample when the container is gone. */
  sample: () => Promise<ContainerStabilitySample>;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Poll `sample()` until the outcome is settled or the window closes.
 *
 * Never throws for workload reasons — a sampling error surfaces as a `missing`
 * sample only if the caller's `sample` says so; anything else propagates, since
 * a runtime we cannot talk to is the caller's call to interpret (a lost SSH
 * connection means "unknown", not "failed").
 */
export async function watchContainerStability(
  deps: WatchStabilityDeps,
  opts: StabilityOptions,
): Promise<StabilityVerdict> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  const first = await deps.sample();
  const alreadyUp = Math.max(0, Math.min(opts.alreadyRunningMs ?? 0, opts.windowMs));
  const deadline = now() + Math.max(0, opts.windowMs - alreadyUp);

  let latest = first;
  for (;;) {
    const windowElapsed = now() >= deadline;
    const verdict = classifyStability(first, latest, { ...opts, windowElapsed });
    if (verdict) return verdict;
    const remaining = deadline - now();
    await sleep(Math.max(0, Math.min(opts.pollMs, remaining)));
    latest = await deps.sample();
  }
}
