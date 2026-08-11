/**
 * In-instance "is anything listening on this port?" probe.
 *
 * Unlike `reachability.ts` (which dials the target from the API host), this runs
 * INSIDE the deployment (docker container / cloud workspace / bare host) via a
 * CommandExecutor and reads the kernel's own socket table. It exists because a
 * host-side TCP probe can't reach cloud/remote targets, and because the tool the
 * naive approach reaches for — `lsof -i :PORT` — is (a) absent on minimal images
 * and (b) prone to missing IPv6-only (or IPv4-only) listeners.
 *
 * Method: `cat /proc/net/tcp` + `/proc/net/tcp6` (needs only busybox `sh` + `cat`,
 * present on every runtime image incl. Alpine/Oblien) and parse in TypeScript.
 * Reading BOTH files and unioning them is what eliminates the address-family
 * false negative: a process bound to `0.0.0.0:PORT` shows in tcp, one bound to
 * `:::PORT` (or Node's default dual-stack) shows in tcp6 — either counts.
 */

/** Minimal command surface this probe needs. A full `CommandExecutor` satisfies it. */
export interface PortProbeExecutor {
  exec(command: string, opts?: { timeout?: number }): Promise<string>;
}

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

// Dump both address families; suppress stderr and force exit 0 so a missing
// file (rare) or an empty family never rejects the exec. Parsing is per-line and
// family-agnostic, so no separator is needed between the two files.
const PROC_NET_TCP_CMD = "cat /proc/net/tcp 2>/dev/null; cat /proc/net/tcp6 2>/dev/null; true";

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
 * One probe. Resolves `true`/`false` for "port is listening", or `null` when the
 * exec itself failed (inconclusive). Never throws.
 */
export async function probePortListeningOnce(
  executor: PortProbeExecutor,
  port: number,
): Promise<boolean | null> {
  try {
    const out = await executor.exec(PROC_NET_TCP_CMD, { timeout: 5_000 });
    return parseListeningPorts(out).has(port);
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

  return anyConclusive
    ? { listening: false, checked: true }
    : { listening: false, checked: false };
}
