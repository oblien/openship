/**
 * Remote command journaling — the exactly-once mechanism.
 *
 * A tiny POSIX wrapper (`opsh-run`) is deployed once per server under
 * `<baseDir>/bin/`. It runs a command DETACHED (survives an SSH drop / channel
 * SIGHUP) and journals its stdout/stderr/exit-code to `<baseDir>/ops/<opId>/`,
 * keyed by a caller-chosen operation id. The launch is guarded by an atomic
 * `mkdir` of the op dir, so a reconnect-replay of the same opId re-attaches and
 * HARVESTS the recorded result instead of re-running the command — exactly-once
 * across a mid-command disconnect, and recovery of the in-flight result.
 *
 * This module is STATELESS: every function takes the executor as an argument,
 * so the connection manager can hand it a FRESH executor after a reconnect and
 * re-drive the same opId. It uses only `exec.exec()`, so it works identically
 * on the in-process ssh2 path and the OpenSSH ControlMaster path.
 *
 * Wrapper stdout is always a single base64 frame (survives exec()'s trim +
 * stdout-only capture):
 *   OPSH1 <code> <b64stdout> <b64stderr>  — completed; harvested
 *   OPSH-RUNNING <pid>                     — still running after --wait; re-invoke
 *   OPSH-DEAD                              — launched, pid gone, no exit → lost
 *   OPSH-COLLISION                         — opId reused with a different command
 *   OPSH-EIO <msg>                         — cannot journal (disk/input) → refuse
 */

import type { CommandExecutor } from "../types";
import { sq } from "./local-shell";
import { LocalExecutor } from "./local-executor";
import { isRetryableRemoteConnectionError } from "./errors";

/** Bump when the wrapper script changes — forces a redeploy on the next ensure. */
export const OPSH_RUN_VERSION = 1;

/** Default remote base dir owning bin/ + ops/. Mirrors apps/api's OPENSHIP_DIR
 *  (openship-server-store.ts) so adapter-layer callers don't cross the layer
 *  boundary to journal. Keep the two in sync. */
export const DEFAULT_JOURNAL_BASE = "/root/.openship";

/**
 * Same non-interactive env both executors prepend to plain `exec()`, applied to
 * the JOURNALED command (via --env-prefix) so apt/dpkg behave identically.
 */
export const REMOTE_ENV_PREFIX =
  "export DEBIAN_FRONTEND=noninteractive DPKG_FORCE=confnew && ";

/**
 * The wrapper script. POSIX `sh`; targets are GNU/Linux (coreutils base64/
 * sha256sum/find). Kept free of `${...}` param-expansion so it embeds cleanly
 * in this template literal — only `$VAR`, `$(...)`, `$((...))` are used.
 */
const OPSH_RUN_SCRIPT = `#!/bin/sh
# opsh-run — openship reliable command journal. Managed file; do not edit.
VERSION=${OPSH_RUN_VERSION}

BASE="$OPSH_BASE"
[ -z "$BASE" ] && BASE=/root/.openship
OPS="$BASE/ops"

if [ "$1" = "--version" ]; then echo "$VERSION"; exit 0; fi

if [ "$1" = "--gc" ]; then
  TTLMIN=1440
  [ -n "$2" ] && TTLMIN="$2"
  [ -d "$OPS" ] || exit 0
  for d in "$OPS"/*; do
    [ -d "$d" ] || continue
    if [ -f "$d/exit" ]; then
      [ -n "$(find "$d/exit" -mmin +"$TTLMIN" 2>/dev/null)" ] && rm -rf "$d"
    else
      if [ -n "$(find "$d" -maxdepth 0 -mmin +1440 2>/dev/null)" ]; then
        p="$(cat "$d/pid" 2>/dev/null)"
        { [ -z "$p" ] || ! kill -0 "$p" 2>/dev/null; } && rm -rf "$d"
      fi
    fi
  done
  exit 0
fi

OPID="$1"
CMDB64="$2"
shift 2
WAIT=25
ENVPREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) [ $# -ge 2 ] && WAIT="$2"; shift 2 2>/dev/null || shift ;;
    --env-prefix) [ $# -ge 2 ] && ENVPREFIX="$(printf %s "$2" | openssl base64 -d -A 2>/dev/null)"; shift 2 2>/dev/null || shift ;;
    *) shift ;;
  esac
done

DIR="$OPS/$OPID"
CMD="$(printf %s "$CMDB64" | openssl base64 -d -A 2>/dev/null)"
[ -z "$CMD" ] && { echo "OPSH-EIO badcmd"; exit 0; }
HASH="$(printf %s "$CMD" | openssl dgst -sha256 2>/dev/null | awk '{print $NF}')"

if mkdir -p "$OPS" 2>/dev/null && mkdir "$DIR" 2>/dev/null; then
  # Launcher: exactly one invocation per opId reaches here (mkdir is atomic).
  if ! printf %s "$HASH" > "$DIR/cmdhash" 2>/dev/null; then
    rm -rf "$DIR" 2>/dev/null; echo "OPSH-EIO nowrite"; exit 0
  fi
  printf %s "$CMD" > "$DIR/cmd" 2>/dev/null
  # Subshell (not brace group) so a command that calls \`exit\` terminates only
  # the subshell — the exit code is still captured and journaled.
  RUN="( $ENVPREFIX $CMD ) > $DIR/stdout 2> $DIR/stderr; "'c=$?; echo $c'" > $DIR/exit.tmp && mv $DIR/exit.tmp $DIR/exit"
  # nohup + </dev/null + & detaches from the SSH channel: a dropped connection
  # (channel SIGHUP) can't kill the work. $! stays the running shell's pid.
  nohup sh -c "$RUN" </dev/null >/dev/null 2>&1 &
  echo $! > "$DIR/pid" 2>/dev/null
else
  # Attach/harvest. Guard against a reused opId carrying a different command.
  [ -d "$DIR" ] || { echo "OPSH-EIO nodir"; exit 0; }
  prev="$(cat "$DIR/cmdhash" 2>/dev/null)"
  [ -n "$prev" ] && [ "$prev" != "$HASH" ] && { echo "OPSH-COLLISION"; exit 0; }
fi

# Wait up to WAIT seconds for the exit file (published atomically AFTER the
# stdout/stderr fds close → a visible exit means output is final).
i=0
max=$((WAIT * 5))
while [ ! -f "$DIR/exit" ]; do
  p="$(cat "$DIR/pid" 2>/dev/null)"
  if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; then
    [ -f "$DIR/exit" ] && break
    echo "OPSH-DEAD"; exit 0
  fi
  i=$((i + 1))
  if [ "$i" -ge "$max" ]; then echo "OPSH-RUNNING $p"; exit 0; fi
  sleep 0.2
done

CODE="$(cat "$DIR/exit" 2>/dev/null)"
[ -z "$CODE" ] && CODE=1
OUT="$(openssl base64 -A < "$DIR/stdout" 2>/dev/null)"
ERR="$(openssl base64 -A < "$DIR/stderr" 2>/dev/null)"
echo "OPSH1 $CODE $OUT $ERR"
exit 0
`;

export interface JournalRunResult {
  status: "done" | "running" | "dead" | "collision" | "eio";
  /** Exit code (status "done" only). */
  code?: number;
  stdout?: string;
  stderr?: string;
  /** Detail for status "eio". */
  message?: string;
}

export interface RunJournaledOptions {
  /** Remote base dir owning bin/ + ops/ (e.g. "/root/.openship"). */
  baseDir: string;
  /** Seconds the wrapper blocks waiting for completion before returning
   *  "running" (the client then re-invokes). Default 25. */
  waitSecs?: number;
  /** Prefix prepended to the journaled command (default REMOTE_ENV_PREFIX). */
  envPrefix?: string;
}

/**
 * Deploy the wrapper if missing/outdated, then GC old op dirs. Cheap to call
 * once per connection; the manager caches "ensured" per executor instance.
 */
export async function ensureRemoteJournal(
  exec: CommandExecutor,
  baseDir: string,
): Promise<void> {
  const runner = `${baseDir}/bin/opsh-run`;

  let current = -1;
  try {
    const out = await exec.exec(
      `OPSH_BASE=${sq(baseDir)} sh ${sq(runner)} --version 2>/dev/null`,
      { timeout: 10_000 },
    );
    current = Number.parseInt(out.trim(), 10);
  } catch {
    current = -1; // missing / unreadable
  }

  if (current !== OPSH_RUN_VERSION) {
    // Atomic deploy: write temp → chmod → mv (mirrors writeOpenshipFile).
    const tmp = `${runner}.tmp`;
    await exec.writeFile(tmp, OPSH_RUN_SCRIPT);
    await exec.exec(
      `mkdir -p ${sq(`${baseDir}/ops`)} && chmod 0700 ${sq(tmp)} && mv -f ${sq(tmp)} ${sq(runner)}`,
    );
  }

  // Best-effort GC — never fail ensure because pruning hiccupped.
  try {
    await exec.exec(`OPSH_BASE=${sq(baseDir)} sh ${sq(runner)} --gc 2>/dev/null`, {
      timeout: 15_000,
    });
  } catch {
    /* GC is best-effort */
  }
}

/**
 * Invoke the wrapper ONCE for `opId`: launches the detached command on first
 * call, re-attaches on later calls, and blocks up to `waitSecs` for completion.
 * Returns the parsed frame. Propagates if the executor's transport drops (the
 * caller reconnects and re-invokes with the same opId).
 */
export async function runJournaled(
  exec: CommandExecutor,
  opId: string,
  command: string,
  opts: RunJournaledOptions,
): Promise<JournalRunResult> {
  const waitSecs = Math.max(1, Math.min(300, opts.waitSecs ?? 25));
  const runner = `${opts.baseDir}/bin/opsh-run`;
  const cmdB64 = Buffer.from(command, "utf8").toString("base64");
  const envPrefix = opts.envPrefix ?? REMOTE_ENV_PREFIX;
  const envB64 = Buffer.from(envPrefix, "utf8").toString("base64");

  let invocation =
    `OPSH_BASE=${sq(opts.baseDir)} sh ${sq(runner)} ${sq(opId)} ${cmdB64} --wait ${waitSecs}`;
  // Omit --env-prefix entirely when empty (a dangling flag with no value would
  // break the wrapper's arg parsing).
  if (envB64) invocation += ` --env-prefix ${envB64}`;

  // Give the SSH command generous headroom over the wrapper's own wait window.
  const raw = await exec.exec(invocation, { timeout: (waitSecs + 20) * 1000 });
  return parseFrame(raw);
}

/** Parse the single wrapper frame (the last non-empty stdout line). */
export function parseFrame(raw: string): JournalRunResult {
  const line = raw
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? "";

  if (line.startsWith("OPSH1 ")) {
    const parts = line.split(" ");
    const code = Number.parseInt(parts[1] ?? "", 10);
    const decode = (b64?: string) =>
      b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
    return {
      status: "done",
      code: Number.isFinite(code) ? code : 1,
      stdout: decode(parts[2]),
      stderr: decode(parts[3]),
    };
  }
  if (line.startsWith("OPSH-RUNNING")) return { status: "running" };
  if (line === "OPSH-DEAD") return { status: "dead" };
  if (line === "OPSH-COLLISION") return { status: "collision" };
  if (line.startsWith("OPSH-EIO")) {
    return { status: "eio", message: line.slice("OPSH-EIO ".length).trim() || "journal I/O error" };
  }
  return { status: "eio", message: `unrecognized journal frame: ${line.slice(0, 160)}` };
}

// ─── Reliable run (journaled + reconnect-and-re-drive) ─────────────────────────

/**
 * A journaled op was interrupted (transport dropped, remote process died) with
 * NO recorded exit — its outcome is unknown. Distinct from a clean non-zero
 * exit. Callers must treat it as "did not complete" and never silently re-run.
 */
export class OpInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpInterruptedError";
  }
}

export interface ReliableRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunReliableOptions {
  /** Remote base dir owning bin/ + ops/. Defaults to DEFAULT_JOURNAL_BASE. */
  baseDir?: string;
  /** Overall deadline across reconnects (default 15 min). */
  timeoutMs?: number;
  /** Per-invocation remote wait window, seconds (default 25). */
  waitSecs?: number;
  /** Prefix prepended to the journaled command (default REMOTE_ENV_PREFIX). */
  envPrefix?: string;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Skip re-deploying the wrapper for executors already ensured this session. */
  ensured?: WeakSet<CommandExecutor>;
  /** Called on a retryable transport drop, before backoff (e.g. drop the pooled
   *  connection so the next acquire() returns a fresh one, bump a breaker). */
  onRetryableDrop?: (err: unknown) => void;
  /** Called once a terminal success is reached. */
  onSuccess?: () => void;
}

const DEFAULT_RELIABLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/**
 * Drive one journaled op to a terminal result with EXACTLY-ONCE semantics,
 * reconnecting with backoff across transport drops. `acquire` returns the
 * executor to use (the caller may reconnect / swap it — a plain SshExecutor
 * self-heals on next use, so returning the same instance is fine). The same
 * opId is re-sent each iteration, so the remote wrapper harvests a completed
 * op instead of re-running it. Long-polls while the remote reports "running".
 *
 * This is the shared core used by BOTH the apps/api connection manager and the
 * adapter-layer runtimes (deploy commit, installers), so every mutating remote
 * command that adopts it gets identical exactly-once behavior.
 */
export async function runReliable(
  acquire: () => Promise<CommandExecutor>,
  opId: string,
  command: string,
  opts: RunReliableOptions,
): Promise<ReliableRunResult> {
  const baseDir = opts.baseDir ?? DEFAULT_JOURNAL_BASE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RELIABLE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const minMs = opts.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS;
  const maxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  const envPrefix = opts.envPrefix ?? REMOTE_ENV_PREFIX;
  let backoff = minMs;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`Op '${opId}' timed out after ${timeoutMs}ms`);
    }

    let executor: CommandExecutor;
    try {
      executor = await acquire();
    } catch (err) {
      const wait = Math.min(backoff, deadline - Date.now());
      if (wait <= 0) throw err;
      await sleep(wait);
      backoff = Math.min(backoff * 2, maxMs);
      continue;
    }

    try {
      if (!opts.ensured || !opts.ensured.has(executor)) {
        await ensureRemoteJournal(executor, baseDir);
        opts.ensured?.add(executor);
      }
      const waitSecs = Math.min(
        opts.waitSecs ?? 25,
        Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
      );
      const r = await runJournaled(executor, opId, command, {
        baseDir,
        waitSecs,
        envPrefix,
      });

      switch (r.status) {
        case "done":
          opts.onSuccess?.();
          return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
        case "running":
          backoff = minMs; // alive; keep long-polling without backoff
          continue;
        case "dead":
          throw new OpInterruptedError(
            `Op '${opId}' was interrupted and did not complete (no exit recorded).`,
          );
        case "collision":
          throw new Error(`Op id '${opId}' was reused with a different command.`);
        case "eio":
          throw new Error(`Remote journal error for op '${opId}': ${r.message ?? "unknown"}`);
      }
    } catch (err) {
      if (err instanceof OpInterruptedError) throw err;
      if (isRetryableRemoteConnectionError(err)) {
        opts.onRetryableDrop?.(err);
        const wait = Math.min(backoff, deadline - Date.now());
        if (wait <= 0) throw err;
        await sleep(wait);
        backoff = Math.min(backoff * 2, maxMs);
        continue; // re-drive the SAME opId → harvest (exactly-once)
      }
      throw err;
    }
  }
}

/**
 * Adapter-runtime convenience: run a bounded mutating command with exactly-once
 * semantics on a raw executor, throwing on a non-zero exit (drop-in for
 * `executor.exec`) and returning trimmed stdout. For a LocalExecutor it just
 * runs directly — local execution has no transport to drop, and the journal
 * base (/root/.openship) may not be writable on the API host.
 */
export async function execReliable(
  executor: CommandExecutor,
  opId: string,
  command: string,
  opts: RunReliableOptions = {},
): Promise<string> {
  if (executor instanceof LocalExecutor) {
    return executor.exec(command);
  }
  const r = await runReliable(() => Promise.resolve(executor), opId, command, opts);
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || r.stdout.trim() || `Exit code ${r.code}`);
  }
  return r.stdout.trim();
}
