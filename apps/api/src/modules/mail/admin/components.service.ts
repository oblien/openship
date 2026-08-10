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
 *     systemd; supervisorctl behaves that way already); the daemon cycles in
 *     the background and Health tab polling reflects the new state seconds later.
 *   • Wrap commands as `( … ; echo __EXIT=$?__ ) 2>&1`. The subshell
 *     always exits 0 (echo succeeds), so the SSH layer always sees a
 *     clean close. We parse the real exit code from stdout.
 *   • Cap remote-side execution with `timeout N` for log tails so a
 *     stuck journal can't tie up the SSH session.
 */

import { safeErrorMessage } from "@repo/core";

import { MAIL_COMPONENTS } from "../mail-health.service";
import { mailUnitActionCommand, mailUnitLogsCommand, runMailCommand } from "../mail-engine";

export class UnknownComponentError extends Error {}

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
  build: (flavor: "container" | "host" | "none") => string,
  timeoutMs: number,
): Promise<{ output: string; code: number }> {
  // Wrapping subshell: real command runs, exit marker is emitted on stdout,
  // subshell always returns 0 so ssh2 closes cleanly.
  const { output: raw } = await runMailCommand(
    serverId,
    (flavor) => `( ${build(flavor)} ; echo __EXIT=$?__ ) 2>&1`,
    { timeout: timeoutMs, requireRunning: false },
  );
  const match = raw.match(/__EXIT=(\d+)__\s*$/);
  if (!match) {
    // No marker means the wrapping shell never reached the echo - either
    // killed mid-flight or output was truncated. Treat as failure with the
    // raw output as the error body.
    return { output: raw.trim(), code: -1 };
  }
  const code = Number(match[1]);
  const output = raw.replace(/__EXIT=\d+__\s*$/, "").trim();
  return { output, code };
}

export interface ComponentActionResult {
  key: string;
  unit: string;
  action: ComponentAction;
  /** Trimmed combined stdout+stderr from systemctl. Empty on a clean run. */
  output: string;
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
  if (code !== 0) {
    throw new Error(output || `${action} ${unit} failed (exit ${code})`);
  }
  return { key, unit, action, output };
}

export interface ComponentLogs {
  key: string;
  unit: string;
  /** Newest-last journal lines. */
  lines: string[];
}

/**
 * Tail recent log lines for a component. We cap the request size
 * server-side so a misbehaving client can't ask for a million lines and
 * tie up the SSH session, and use a remote-side `timeout` so a hung
 * journal can't sit on the SSH channel either.
 */
export async function getComponentLogs(
  serverId: string,
  key: string,
  requested?: number,
): Promise<ComponentLogs> {
  const unit = resolveUnit(key);
  const n = clampLines(requested);
  const { output } = await execWithExitMarker(
    serverId,
    (flavor) => mailUnitLogsCommand(flavor, key, unit, n),
    15_000,
  );
  const lines = output
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  return { key, unit, lines };
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
      if (code === 0) {
        results.push({ key: comp.key, unit: comp.unit, ok: true });
      } else if (/not[-\s]?found|not loaded/i.test(output)) {
        // Unit isn't installed on this host - treat as a no-op.
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
