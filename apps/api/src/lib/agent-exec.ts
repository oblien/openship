/**
 * Command execution as a request/response capability, for agents.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The platform already had two ways to run a command, and neither was usable by
 * an AI agent:
 *
 *   - The terminals (`/api/terminal/ws/:serverId`, `/api/services/terminal/ws/:id`)
 *     are WebSocket upgrades. MCP dispatches a plain HTTP request, so no tool can
 *     ever reach them.
 *   - A custom command JOB could run anything on any server — but `job` is an
 *     ORG-SINGLETON, so the grant is all-or-nothing: an agent scoped to one server
 *     could not use it, and an agent that could use it reached every server in the
 *     org. That is the opposite of least privilege, and it made "give the agent a
 *     shell on this one box" inexpressible.
 *
 * So exec here is deliberately hung off the RESOURCE's own permission tag rather
 * than a feature tag. `server:admin` on `:id` means a `{server, S1, [admin]}` grant
 * confines an agent to exactly S1; `project:service:write` on `:serviceId` confines
 * it to one project's services. Per-resource scope falls out of the existing grant
 * model instead of needing a new one.
 *
 * ── What is deliberately NOT defended against ───────────────────────────────
 * The command string is free-form shell, by design — that is the capability being
 * granted. Sanitizing it would be theatre: anyone who can run `sh` can run
 * anything the target user can. The security boundary is the PERMISSION CHECK and
 * the audit record, not command inspection. What we do defend:
 *
 *   - Every value WE interpolate (cwd, container id) is shell-quoted. The command
 *     is the caller's; the framing around it must never be.
 *   - A hard timeout, because an MCP tool call blocks on the response.
 *   - An output cap, because the dispatcher buffers the whole body into the
 *     agent's context.
 *   - Every invocation is audited, with the command recorded — an exec that ran is
 *     the single most important thing to be able to reconstruct afterwards.
 */

import { shellQuote } from "@repo/core";
import type { CommandExecutor, ExecOnly } from "@repo/adapters";

/** Ceiling on how long a single exec may run. Also the default. */
export const EXEC_TIMEOUT_MAX_MS = 120_000;
export const EXEC_TIMEOUT_DEFAULT_MS = 30_000;
/**
 * Ceiling on returned output. The MCP dispatcher reads the entire response body
 * into a string and hands it to the model, so an uncapped `cat` of a large file is
 * an out-of-memory or a blown context window rather than a useful answer.
 */
export const EXEC_OUTPUT_MAX_BYTES = 128 * 1024;

export interface AgentExecResult {
  exitCode: number;
  /** stdout and stderr interleaved, in the order the command produced them. */
  output: string;
  /** True when `output` was cut at the cap — the command itself still finished. */
  truncated: boolean;
  /** True when the timeout fired. `exitCode` is then meaningless. */
  timedOut: boolean;
  durationMs: number;
}

export interface AgentExecOptions {
  command: string;
  /** Working directory. Shell-quoted before use. */
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function clampTimeout(ms: number | undefined): number {
  if (!ms || !Number.isFinite(ms)) return EXEC_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(Math.trunc(ms), 1_000), EXEC_TIMEOUT_MAX_MS);
}

function clampBytes(n: number | undefined): number {
  if (!n || !Number.isFinite(n)) return EXEC_OUTPUT_MAX_BYTES;
  return Math.min(Math.max(Math.trunc(n), 1_024), EXEC_OUTPUT_MAX_BYTES);
}

/** `cd <dir> && ( <cmd> )` — the only place we wrap the caller's command. */
function withCwd(command: string, cwd: string | undefined): string {
  if (!cwd) return command;
  // Quoted: a cwd containing a space or a `;` must be a path, never more shell.
  return `cd ${shellQuote(cwd)} && ${command}`;
}

/**
 * Run a command ON THE HOST, over the pooled SSH executor.
 *
 * Uses `streamExec` rather than `exec` for two reasons: it returns the real exit
 * code instead of rejecting on non-zero (an agent needs to see `exit 1` and its
 * stderr, not an exception), and streaming lets us stop ACCUMULATING at the cap
 * instead of buffering everything and trimming afterwards.
 */
export async function execOnHost(
  executor: CommandExecutor,
  opts: AgentExecOptions,
): Promise<AgentExecResult> {
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const maxBytes = clampBytes(opts.maxOutputBytes);
  const started = Date.now();

  let bytes = 0;
  let truncated = false;
  const chunks: string[] = [];
  const onLog = (log: { message?: string }) => {
    if (truncated) return;
    const line = `${log.message ?? ""}\n`;
    if (bytes + line.length > maxBytes) {
      truncated = true;
      return;
    }
    bytes += line.length;
    chunks.push(line);
  };

  // `streamExec` honours an AbortSignal by killing the child, which is what makes
  // the timeout real rather than merely giving up on the promise and leaving the
  // remote command running against a pooled connection.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let timedOut = false;
  try {
    const res = await executor.streamExec(withCwd(opts.command, opts.cwd), onLog, {
      signal: abort.signal,
    });
    return {
      exitCode: res.code,
      output: chunks.join(""),
      truncated,
      timedOut: false,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    timedOut = abort.signal.aborted;
    if (!timedOut) throw err;
    return {
      exitCode: -1,
      output: chunks.join(""),
      truncated,
      timedOut: true,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Marks the exit code in the wrapped output. Long and unlikely to occur naturally. */
const EXIT_SENTINEL = "__openship_exec_exit__:";

/**
 * Run a command INSIDE a running service container.
 *
 * The runtime's in-container executor is an `ExecOnly` — it resolves to stdout and
 * REJECTS on a non-zero exit, which loses both the exit code and stderr. An agent
 * debugging a service needs both, so the command is wrapped to always exit 0 and
 * report the real status on a sentinel line:
 *
 *   exec 2>&1; <cmd>; printf '\n<sentinel><code>'
 *
 * `exec 2>&1` merges stderr for the remainder of the shell, which is POSIX and
 * works under dash as well as bash — `PIPESTATUS`, the obvious alternative, is a
 * bashism and these containers are frequently Alpine.
 *
 * Unlike the host path the cap is applied AFTER transfer: `ExecOnly` hands back one
 * finished string, so there is nothing to stop mid-flight. The timeout is what
 * bounds a runaway command here.
 */
export async function execInContainer(
  executor: ExecOnly,
  opts: AgentExecOptions,
): Promise<AgentExecResult> {
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const maxBytes = clampBytes(opts.maxOutputBytes);
  const started = Date.now();

  const wrapped = `exec 2>&1; ${withCwd(opts.command, opts.cwd)}; printf '\\n${EXIT_SENTINEL}%s' "$?"`;

  let raw: string;
  try {
    raw = await executor.exec(wrapped, { timeout: timeoutMs });
  } catch (err) {
    // The wrapper exits 0 for any command outcome, so a rejection here is the
    // TRANSPORT failing (timeout, container gone, daemon unreachable) — not the
    // command reporting failure.
    const msg = err instanceof Error ? err.message : String(err);
    const looksLikeTimeout = /timed?\s*out|ETIMEDOUT/i.test(msg);
    if (!looksLikeTimeout) throw err;
    return {
      exitCode: -1,
      output: "",
      truncated: false,
      timedOut: true,
      durationMs: Date.now() - started,
    };
  }

  // Split the sentinel off the tail. A command that printed something sentinel-like
  // itself cannot fool this: we take the LAST occurrence, which is always ours.
  const idx = raw.lastIndexOf(EXIT_SENTINEL);
  let output = idx >= 0 ? raw.slice(0, idx) : raw;
  const exitCode = idx >= 0 ? Number.parseInt(raw.slice(idx + EXIT_SENTINEL.length).trim(), 10) : 0;

  // Trailing newline we added before the sentinel.
  if (output.endsWith("\n")) output = output.slice(0, -1);

  const truncated = output.length > maxBytes;
  if (truncated) output = output.slice(0, maxBytes);

  return {
    exitCode: Number.isFinite(exitCode) ? exitCode : 0,
    output,
    truncated,
    timedOut: false,
    durationMs: Date.now() - started,
  };
}
