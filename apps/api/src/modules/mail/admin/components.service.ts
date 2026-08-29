/**
 * Per-component actions for the mail admin Health tab.
 *
 * Start / stop / restart a daemon and tail its logs, over whichever engine the
 * box runs — the commands come from `../mail-engine.ts`, which owns the
 * supervisord-vs-systemd split. Only keys declared in MAIL_COMPONENTS are
 * accepted; we never pass a caller-supplied unit name to a supervisor. That
 * removes the entire class of "exec arbitrary command" issues from this surface.
 *
 * `action` is restricted to restart / start / stop. Disable / enable /
 * mask deliberately live outside this surface: they change boot behaviour
 * and are usually a sign the operator wants to SSH in and inspect, not
 * click a button.
 *
 * --- Timeout/exit-code hardening ---------------------------------------
 *
 * Two failure modes plagued the first cut of this file:
 *
 *  1. `systemctl restart dovecot` can legitimately take 30-90 s when
 *     workers are stuck holding IMAP sessions; the SSH per-command 30 s
 *     timeout would trip before systemd finished cycling.
 *  2. ssh2 occasionally closes the exec channel without an exit code -
 *     the executor's `code !== 0` check then mis-classifies a clean run
 *     as failure (`Exit code undefined`).
 *
 * Fixes applied below:
 *   • Return the instant the supervisor accepts the job (`--no-block` on
 *     systemd; supervisorctl behaves that way already), then re-probe once so the
 *     answer carries the daemon's OBSERVED state and not the acknowledgement — a
 *     daemon that FATALs on its next breath must not come back as "restarted".
 *     A daemon that dies later still belongs to the Health tab's 10 s poll.
 *   • Wrap commands as `( … ; echo __EXIT=$?__ ) 2>&1`. The subshell
 *     always exits 0 (echo succeeds), so the SSH layer always sees a
 *     clean close. We parse the real exit code from stdout.
 *   • Cap remote-side execution with `timeout N` for log tails so a stuck
 *     read can't tie up the SSH session.
 */

import { AppError, safeErrorMessage } from "@repo/core";

import { MAIL_COMPONENTS } from "../mail-health.service";
import {
  mailUnitActionCommand,
  mailUnitLogsRead,
  mailUnitProbeCommand,
  parseMailUnitProbe,
  runMailCommand,
  type MailEngineFlavor,
  type MailUnitState,
} from "../mail-engine";

export class UnknownComponentError extends Error {}

/**
 * A daemon the supervisor refused to bring up. 409, not 500: nothing here is broken
 * except the daemon, and the panel offers logs + retry off the code.
 */
export class MailComponentActionError extends AppError {
  constructor(message: string) {
    super(message, 409, "MAIL_COMPONENT_ACTION_FAILED");
    this.name = "MailComponentActionError";
  }
}

export type ComponentAction = "restart" | "start" | "stop";

const ACTIONS: readonly ComponentAction[] = ["restart", "start", "stop"];

function resolveUnit(key: string): string {
  const comp = MAIL_COMPONENTS.find((c) => c.key === key);
  if (!comp) {
    throw new UnknownComponentError(`Unknown component: ${key}`);
  }
  return comp.unit;
}

/**
 * Run a flavor-correct command and parse the exit code from a stdout sentinel
 * rather than relying on ssh2's exit-status delivery. Returns the trimmed
 * output (sentinel stripped) and the parsed exit code.
 *
 * `build(flavor)` renders the inner command; the sentinel wrapper goes around it
 * here, so this file never has to know which supervisor it's talking to.
 * `requireRunning: false` — acting on a daemon is exactly what you do when the
 * engine ISN'T fully up, so the gate must not refuse it; only a box with no mail
 * engine at all fails fast (as a typed 409).
 */
async function execWithExitMarker(
  serverId: string,
  build: (flavor: MailEngineFlavor) => string,
  timeoutMs: number,
): Promise<{ flavor: MailEngineFlavor; output: string; code: number }> {
  // Wrapping subshell: real command runs, exit marker is emitted on stdout,
  // subshell always returns 0 so ssh2 closes cleanly.
  const { flavor, output: raw } = await runMailCommand(
    serverId,
    (f) => `( ${build(f)} ; echo __EXIT=$?__ ) 2>&1`,
    { timeout: timeoutMs, requireRunning: false },
  );
  const match = raw.match(/__EXIT=(\d+)__\s*$/);
  if (!match) {
    // No marker means the wrapping shell never reached the echo - either
    // killed mid-flight or output was truncated. Treat as failure with the
    // raw output as the error body.
    return { flavor, output: raw.trim(), code: -1 };
  }
  const code = Number(match[1]);
  const output = raw.replace(/__EXIT=\d+__\s*$/, "").trim();
  return { flavor, output, code };
}

export interface ComponentActionResult {
  key: string;
  unit: string;
  action: ComponentAction;
  /** Trimmed combined stdout+stderr from the supervisor. Empty on a clean run. */
  output: string;
  /**
   * What the daemon was doing a moment after the supervisor accepted the job.
   *
   * "Accepted" is not "running": `supervisorctl restart` returns as soon as the
   * program survives `startsecs`, so a ClamAV that FATALs on its next breath used to
   * come back as an unqualified success and the UI toasted "ClamAV restarted".
   * Absent when the state was still TRANSITIONAL or the probe itself failed — the
   * caller then keeps its optimistic wording rather than crying wolf over a daemon
   * that is simply still starting.
   */
  settled?: MailUnitState;
}

export async function runComponentAction(
  serverId: string,
  key: string,
  action: ComponentAction,
): Promise<ComponentActionResult> {
  if (!ACTIONS.includes(action)) {
    throw new UnknownComponentError(`Unknown action: ${action}`);
  }
  const unit = resolveUnit(key);
  const { output, code } = await execWithExitMarker(
    serverId,
    (flavor) => mailUnitActionCommand(flavor, key, unit, action),
    20_000,
  );
  if (!NOT_INSTALLED.test(output) && (code !== 0 || FATAL_REFUSAL.test(output))) {
    throw new MailComponentActionError(output || `${action} ${unit} failed (exit ${code})`);
  }
  return { key, unit, action, output, settled: await settledState(serverId, key, unit) };
}

/**
 * "This box doesn't ship that daemon." supervisord says `ERROR (no such process)`,
 * systemd says `not-found` / `not loaded`. Tested BEFORE the refusal grading in both
 * the single and the bulk path, so the two can never grade identical output
 * differently.
 */
const NOT_INSTALLED = /not[-\s]?found|not loaded|no such process/i;

/**
 * Refusals supervisorctl prints on stdout while still exiting 0 — it propagates an
 * exit code for its OWN failures, not the program's, so `code !== 0` alone reported a
 * restart that never happened as a success.
 *
 * `already started` / `not running` are deliberately absent: they mean the box is
 * already in the state we asked for, so they ride back in `output` for the panel to
 * show instead of failing the call.
 */
const FATAL_REFUSAL = /abnormal termination|spawn error|unknown error|not authorized/i;

/** Long enough for a program that dies inside supervisord's `startsecs` to reach BACKOFF. */
const SETTLE_MS = 1_500;

/**
 * Re-read the daemon's state after the supervisor accepted the job.
 *
 * Returns `undefined` — "accepted, not confirmed" — for a probe we could not take AND
 * for a state that is still in motion. `systemctl --no-block restart dovecot` returns
 * instantly and the unit sits in `activating` for 30-90 s, which is the normal case
 * that forced `--no-block` in the first place; reporting that as a disagreement would
 * cry wolf on every healthy slow restart.
 *
 * It also cannot catch a daemon that dies LATER — clamd loading a large signature set
 * can survive `startsecs` and be OOM-killed at t+10 s — which is why the caller
 * downgrades its toast rather than declaring success, and the Health tab's 10 s poll
 * delivers the verdict.
 */
async function settledState(
  serverId: string,
  key: string,
  unit: string,
): Promise<MailUnitState | undefined> {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  try {
    const { flavor, output } = await runMailCommand(
      serverId,
      (f) => mailUnitProbeCommand(f, key, unit),
      { timeout: 15_000, requireRunning: false },
    );
    const state = parseMailUnitProbe(flavor, key, unit, output);
    if (state.status === "activating" || state.status === "deactivating") return undefined;
    if (state.status === "unknown") return undefined;
    return state;
  } catch {
    return undefined;
  }
}

export interface ComponentLogs {
  key: string;
  unit: string;
  /** Newest-last log lines. */
  lines: string[];
  /**
   * The read we performed, in display form: `docker exec openship-mail tail -n 300
   * /var/log/supervisor/clamav-daemon.log` on the container engine, `journalctl -u …`
   * only on a legacy host.
   *
   * Carried with the payload on purpose. The drawer used to print a hardcoded
   * journalctl header, naming a log the container engine has not got — and it must
   * not be re-derived client-side either, which would be a second, unverified guess
   * at this box's topology.
   */
  source: string;
}

/**
 * Tail recent log lines for a component, and report which log they came from. We cap
 * the request size server-side so a misbehaving client can't ask for a million lines
 * and tie up the SSH session, and use a remote-side `timeout` so a hung read can't
 * sit on the SSH channel either.
 */
export async function getComponentLogs(
  serverId: string,
  key: string,
  requested?: number,
): Promise<ComponentLogs> {
  const unit = resolveUnit(key);
  const n = clampLines(requested);
  const read = (flavor: MailEngineFlavor) => mailUnitLogsRead(flavor, key, unit, n);
  const { flavor, output } = await execWithExitMarker(serverId, (f) => read(f).command, 15_000);
  const lines = output
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  return { key, unit, lines, source: read(flavor).source };
}

function clampLines(requested: number | undefined): number {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(Math.floor(n), 1000);
}

// ─── Bulk restart ────────────────────────────────────────────────────────────

export interface BulkRestartResult {
  results: Array<{
    key: string;
    unit: string;
    ok: boolean;
    error?: string;
  }>;
}

/**
 * Restart every component the box advertises (skipping ones whose unit isn't
 * installed). Each restart is accepted-and-returned rather than waited on, so a
 * single slow daemon never blocks the others. The result reports per-unit
 * success — the UI surfaces the failures, the user can dig deeper from the logs
 * drawer.
 *
 * We do NOT enforce a specific order. The supervisor's own dependency config
 * orchestrates actual timing; "restart all" just kicks each unit and trusts it.
 * iRedMail's stack tolerates concurrent restarts well in practice — postgres +
 * postfix + dovecot all settle within seconds.
 *
 * No per-unit re-probe here, unlike the single-component path: nine units would put a
 * 13-second floor on one click. This path stays accept-only and the Health tab's poll
 * is the confirmation; only its OUTPUT grading is shared with the single path.
 */
export async function restartAllComponents(
  serverId: string,
): Promise<BulkRestartResult> {
  const results: BulkRestartResult["results"] = [];
  for (const comp of MAIL_COMPONENTS) {
    try {
      const { output, code } = await execWithExitMarker(
        serverId,
        (flavor) => mailUnitActionCommand(flavor, comp.key, comp.unit, "restart"),
        20_000,
      );
      // Not-installed is graded FIRST: supervisord's `ERROR (no such process)` is
      // this flavor's "this box doesn't ship that daemon", which is a no-op.
      if (NOT_INSTALLED.test(output)) {
        results.push({ key: comp.key, unit: comp.unit, ok: true });
      } else if (code === 0 && !FATAL_REFUSAL.test(output)) {
        results.push({ key: comp.key, unit: comp.unit, ok: true });
      } else {
        results.push({
          key: comp.key,
          unit: comp.unit,
          ok: false,
          error: output.split("\n")[0]?.slice(0, 200) || `Exit ${code}`,
        });
      }
    } catch (err) {
      const msg = safeErrorMessage(err);
      results.push({
        key: comp.key,
        unit: comp.unit,
        ok: false,
        error: msg.split("\n")[0]?.slice(0, 200) || "Restart failed",
      });
    }
  }
  return { results };
}
