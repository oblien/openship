/**
 * How a read-only probe runs a command, and how its failure gets reported.
 *
 * Both halves were written more than once — `tryExec` five times byte-identically, the
 * traced variant twice (`system/checks.ts`, `toolchain/checks.ts`) with the second missing
 * the reporting half. They live together because the difference between them is the thing
 * a caller has to choose deliberately:
 *
 *   `tryExec`    swallows everything, including a dropped transport. For probes whose
 *                answer is optional — one tier of a fallback ladder, a best-effort
 *                rollback — where "couldn't ask" and "asked, got nothing" lead to the
 *                same next step.
 *   `probeExec`  traces the attempt, keeps the failure TEXT, and re-throws a transport
 *                drop. For probes that report a verdict to a human: an unreachable host
 *                must abort the whole check rather than be recorded per-component as
 *                "not installed".
 *
 * In both, the returned emptiness is load-bearing and must not be collapsed:
 *
 *   `tryExec`   → `null` the command did not complete · `""` it completed, printing nothing
 *   `probeExec` → `error` non-null it did not complete · `output` empty, `error` null it did
 *
 * Collapsing those is what made #408 undiagnosable: a probe that FAILED and a probe that
 * answered nothing produced the same static "the daemon is not running", so the daemon's
 * own words — "permission denied while trying to connect to the Docker daemon socket",
 * "Command timed out after 10000ms" — were read off the wire and then discarded in favour
 * of a guess the reporter had no way to check.
 *
 * Neither is for a command that CHANGES the box. A mutation whose failure is discarded is
 * a silent skip, which is the bug class this refactor exists to remove. The one exception
 * is the rollback path in `takeover-journal`, where best-effort is the point and the call
 * site says so.
 */

import { safeErrorMessage } from "@repo/core";

import type { ExecOnly } from "../types";
import { formatDuration, systemDebug } from "./debug";
import { isRemoteConnectionError } from "./errors";

export async function tryExec(
  executor: ExecOnly,
  command: string,
  opts?: { timeout?: number },
): Promise<string | null> {
  try {
    // Forwarded only when set: several suites assert `exec` was called with one argument,
    // and passing an explicit `undefined` would fail those without changing behavior.
    return opts ? await executor.exec(command, opts) : await executor.exec(command);
  } catch {
    return null;
  }
}

/** A traced probe's outcome. `error` is the failure text, null when the command ran. */
export interface ExecOutcome {
  output: string;
  error: string | null;
}

/**
 * Run a probe under the `SYSTEM_DEBUG_LOGS` trace, keeping its failure text.
 *
 * `scope` is the debug channel — the calling subsystem ("checks", "toolchain"), so a trace
 * still says which layer asked. 10s because every caller is a version or daemon probe that
 * either answers immediately or is wedged.
 *
 * Throws only on a transport drop, preserving the contract callers rely on: an SSH host
 * that went away aborts the run instead of being reported component-by-component as a box
 * with nothing installed.
 */
export async function probeExec(
  executor: ExecOnly,
  command: string,
  scope: string,
): Promise<ExecOutcome> {
  const startedAt = Date.now();
  systemDebug(scope, `exec:start ${command}`);
  try {
    const result = await executor.exec(command, { timeout: 10_000 });
    systemDebug(scope, `exec:ok ${command} (${formatDuration(startedAt)})`);
    // Trimmed so "did this produce anything" is an honest test — a whitespace-only reply
    // from a half-answering daemon is not output.
    return { output: result.trim(), error: null };
  } catch (err) {
    const msg = safeErrorMessage(err);
    if (isRemoteConnectionError(err)) {
      systemDebug(scope, `exec:abort ${command} (${formatDuration(startedAt)}) ${msg}`);
      throw err;
    }
    systemDebug(scope, `exec:fail ${command} (${formatDuration(startedAt)}) ${msg}`);
    return { output: "", error: msg || `\`${command}\` failed` };
  }
}

/**
 * Fold a probe's own failure text into the status message, so the UI states the cause
 * instead of repeating a guess. Server owners read this string and act on it; they have a
 * shell on the same box, so there is nothing here they can't already see.
 *
 * First line only, capped: `docker info`, certbot and a failing `--version` can each answer
 * with a paragraph, and the message renders inline in a list row.
 */
export function withReason(message: string, error: string | null): string {
  if (!error) return message;
  const first = error
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return message;
  return `${message} — ${first.length > 200 ? `${first.slice(0, 199)}…` : first}`;
}
