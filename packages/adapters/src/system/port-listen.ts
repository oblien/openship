/**
 * In-instance "is anything listening on this port?" probe.
 *
 * Unlike `reachability.ts` (which dials the target from the API host), this runs
 * INSIDE the deployment (docker container / cloud workspace / bare host) via a
 * CommandExecutor and reads the kernel's socket table or host tools. It exists
 * because a host-side TCP probe can't reach cloud/remote targets.
 *
 * Method:
 *   1. `/proc/net/tcp` + `/proc/net/tcp6` (needs only busybox `sh` + `cat`,
 *      present on every Linux runtime image incl. Alpine/Oblien) and parse in TypeScript.
 *      Reading BOTH files and unioning them is what eliminates the address-family
 *      false negative: a process bound to `0.0.0.0:PORT` shows in tcp, one bound to
 *      `:::PORT` (or Node's default dual-stack) shows in tcp6 — either counts.
 *   2. `lsof -nP -t -iTCP:PORT -sTCP:LISTEN` fallback on macOS / Darwin / BSD
 *      hosts where `/proc` is absent.
 *   3. `ss -tln sport = :PORT` fallback on Linux hosts where procfs is unmounted.
 *   4. An explicit unavailable marker when no probe method is usable, returning
 *      `null` (`checked: false`) so an unmeasurable host is never falsely reported
 *      as "not listening".
 */

import type { ExecOnly } from "../types";

/** Minimal command surface this probe needs. A full `CommandExecutor` satisfies it. */
export type PortProbeExecutor = ExecOnly;

export interface PortProbeResult {
  /** True if a LISTEN socket on the port was found. */
  listening: boolean;
  /**
   * True if the probe actually ran and produced a reading. False means the probe
   * was inconclusive (executor unusable / every attempt errored) — callers must
   * treat `checked:false` as "no signal", never as "not listening".
   */
  checked: boolean;
}

const PROC_NET_TCP_FILES = ["/proc/net/tcp", "/proc/net/tcp6"] as const;

const PROBE_LISTENING = "__OPENSHIP_PORT_LISTENING__";
const PROBE_FREE = "__OPENSHIP_PORT_FREE__";
const PROBE_UNAVAILABLE = "__OPENSHIP_PORT_UNAVAILABLE__";

/**
 * Build the portable fallback used only when neither procfs socket table can be
 * read. The status/output checks matter: a missing or broken probe must remain
 * inconclusive instead of becoming the false "free" result that caused #646.
 */
export function buildPortProbeCommand(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`Invalid TCP port: ${port}`);
  }

  return [
    `lsof_output="$(lsof -nP -t -iTCP:${port} -sTCP:LISTEN 2>&1)"`,
    `lsof_status=$?`,
    `if [ "$lsof_status" -eq 0 ] && [ -n "$lsof_output" ] && printf '%s\\n' "$lsof_output" | grep -Eqv '^[0-9]+$'; then`,
    `  : # Unexpected lsof output: fall through to ss instead of guessing.`,
    `elif [ "$lsof_status" -eq 0 ] && [ -n "$lsof_output" ]; then`,
    `  printf '${PROBE_LISTENING}\\n'`,
    `  exit 0`,
    `elif [ "$lsof_status" -eq 1 ] && [ -z "$lsof_output" ]; then`,
    `  printf '${PROBE_FREE}\\n'`,
    `  exit 0`,
    `fi`,
    `ss_output="$(ss -tln "sport = :${port}" 2>&1)"`,
    `ss_status=$?`,
    `if [ "$ss_status" -eq 0 ] && printf '%s\\n' "$ss_output" | grep -q LISTEN; then`,
    `  printf '${PROBE_LISTENING}\\n'`,
    `elif [ "$ss_status" -eq 0 ]; then`,
    `  printf '${PROBE_FREE}\\n'`,
    `else`,
    `  printf '${PROBE_UNAVAILABLE}\\n'`,
    `fi`,
  ].join("\n");
}

// procfs socket state column: 0A = TCP_LISTEN.
const TCP_LISTEN = "0A";
/**
 * Parse the concatenated contents of /proc/net/tcp and /proc/net/tcp6 into the
 * set of ports in LISTEN state. Pure and family-agnostic — feeding it both files
 * naturally unions IPv4 + IPv6 listeners.
 *
 * Each data row looks like:
 *   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 ...
 * field[1] = local_address (`HEXIP:HEXPORT`), field[3] = state.
 */
export function parseListeningPorts(procText: string): Set<number> {
  const ports = new Set<number>();
  for (const rawLine of procText.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 4) continue;
    if (fields[3] !== TCP_LISTEN) continue; // skips the header row and every non-LISTEN socket
    const local = fields[1];
    const colon = local.lastIndexOf(":");
    if (colon === -1) continue;
    const hexPort = local.slice(colon + 1);
    // A port is at most 0xFFFF (4 hex digits); reject anything that isn't clean hex.
    if (!/^[0-9A-Fa-f]{1,4}$/.test(hexPort)) continue;
    const port = parseInt(hexPort, 16);
    if (port > 0) ports.add(port);
  }
  return ports;
}

/**
 * Parse the output of `buildPortProbeCommand`.
 *
 * Resolves:
 *   - `true` when a LISTEN socket was confirmed.
 *   - `false` when the socket table/tool was read and the port is confirmed NOT listening.
 *   - `null` when the probe was inconclusive (unknown output, tool missing, or error).
 */
export function parsePortProbeOutput(out: string): boolean | null {
  const trimmed = out.trim();
  if (trimmed === PROBE_LISTENING) return true;
  if (trimmed === PROBE_FREE) return false;
  if (trimmed === PROBE_UNAVAILABLE) return null;
  return null;
}

/**
 * One probe. Resolves `true`/`false` for "port is listening", or `null` when the
 * exec itself failed (inconclusive). Never throws.
 */
export async function probePortListeningOnce(
  executor: PortProbeExecutor,
  port: number,
): Promise<boolean | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;

  const readable: string[] = [];
  // Read the families independently and preserve whether each read succeeded.
  // Appending `; true` to one combined shell command made two permission/read
  // failures look exactly like a valid empty socket table—a dangerous false
  // negative for edge ownership checks. One readable family is still useful;
  // neither readable means the probe is inconclusive.
  for (const file of PROC_NET_TCP_FILES) {
    try {
      readable.push(await executor.exec(`cat ${file} 2>/dev/null`, { timeout: 5_000 }));
    } catch {
      // Try the other address family before declaring the probe inconclusive.
    }
  }
  if (readable.length > 0) return parseListeningPorts(readable.join("\n")).has(port);

  try {
    const out = await executor.exec(buildPortProbeCommand(port), { timeout: 5_000 });
    return parsePortProbeOutput(out);
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `probePortListeningOnce` until the port is found listening or the deadline
 * passes — mirrors the shape of `waitForReady` (reachability.ts) because an app
 * may bind its port a beat after the container reports started.
 *
 * NEVER throws. Returns:
 *   - `{ listening:true,  checked:true }`  — found a listener.
 *   - `{ listening:false, checked:true }`  — got at least one real "not listening"
 *      reading and the deadline passed (a genuine negative).
 *   - `{ listening:false, checked:false }` — every attempt errored (executor
 *      unusable): inconclusive, so callers must NOT raise an advisory.
 */
export async function waitForPortListening(
  executor: PortProbeExecutor,
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<PortProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let anyConclusive = false;

  try {
    for (;;) {
      const result = await probePortListeningOnce(executor, port);
      if (result === true) return { listening: true, checked: true };
      if (result === false) anyConclusive = true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(intervalMs, remaining));
    }
  } catch {
    return { listening: false, checked: false };
  }

  return anyConclusive ? { listening: false, checked: true } : { listening: false, checked: false };
}

/** Outcome of {@link waitForPortFree}. `checked:false` = inconclusive, same rule. */
export interface PortFreeResult {
  /** True if the port was observed with no LISTEN socket on it. */
  free: boolean;
  /** True if the probe produced at least one real reading. */
  checked: boolean;
}
/**
 * The mirror of {@link waitForPortListening}: poll until the port is NOT listening.
 *
 * Exists because "I stopped the thing holding :80" and ":80 is actually free" are
 * different facts, and only the second one lets a replacement bind. A stopped
 * systemd unit takes a moment to release the socket, and its master may respawn a
 * worker in between — so the caller that skipped this step started a container that
 * lost the race and crash-looped on `bind() … (98: Address already in use)`, then
 * reported success because `docker run` had exited 0.
 *
 * NEVER throws, and `checked:false` means "no reading" — a caller must not treat an
 * unusable executor as proof the port is free.
 */
export async function waitForPortFree(
  executor: PortProbeExecutor,
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<PortFreeResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let anyConclusive = false;

  try {
    for (;;) {
      const result = await probePortListeningOnce(executor, port);
      if (result === false) return { free: true, checked: true };
      if (result === true) anyConclusive = true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(intervalMs, remaining));
    }
  } catch {
    return { free: false, checked: false };
  }

  return anyConclusive ? { free: false, checked: true } : { free: false, checked: false };
}
