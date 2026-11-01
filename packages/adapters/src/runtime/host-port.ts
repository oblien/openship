import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { CommandExecutor } from "../types";
import { scanPorts } from "../system/port-scan";

/**
 * Allocate a stable LOOPBACK host port for the edge→app hop (loopback-port
 * route strategy). The port is published `127.0.0.1:<hostPort>:<containerPort>`
 * and persisted on the project so redeploys/restarts keep the same target.
 *
 * The default range sits well above the reserved control-plane ports (API,
 * dashboard 3001, OpenResty mgmt 9145 — all < 10000), so the allocator never
 * needs to know about them. Live occupancy is read once via `scanPorts`
 * (ss → procfs), and the caller passes `avoid` = host ports already pinned to
 * OTHER projects (which may not be listening right now). The deploy-time
 * `ensurePortAvailable` prompt is the final backstop if the pick is taken.
 */
const DEFAULT_RANGE_START = 20000;
const DEFAULT_RANGE_END = 29999;

/**
 * Linux's default ephemeral (outbound) port range, used when the target's own
 * `ip_local_port_range` can't be read.
 */
const LINUX_EPHEMERAL_RANGE: PortRange = { start: 32768, end: 60999 };

export interface PortRange {
  start: number;
  end: number;
}

export interface AllocateHostPortOptions {
  /** Reuse this port if it's still free (the project's persisted hostPort). */
  preferred?: number | null;
  /**
   * Treat an occupied preferred port as reusable. Callers may set this only
   * after durable target-scoped ownership proves the listener belongs to the
   * workload that this deploy is about to replace.
   */
  reuseOccupiedPreferred?: boolean;
  /** Host ports reserved by other projects — never hand these out. */
  avoid?: Iterable<number>;
  rangeStart?: number;
  rangeEnd?: number;
  /**
   * The target's ephemeral port range. No port inside it may be allocated or reused:
   * the kernel hands those numbers to outbound connections, so a publish pinned
   * there can find its port taken when the container restarts ("address already
   * in use"), and Docker's restart policy then gives up. Such a pin can come from
   * an observed Docker-assigned publish, which Docker draws from this range.
   */
  ephemeralRange?: PortRange | null;
}

/** Pure: pick the first safe port in [start,end] outside the ephemeral range,
 *  reusing `preferred` when it's safe and free. Exported for testing. */
export function pickHostPort(occupied: Set<number>, opts: AllocateHostPortOptions = {}): number {
  const start = opts.rangeStart ?? DEFAULT_RANGE_START;
  const end = opts.rangeEnd ?? DEFAULT_RANGE_END;
  const avoid = new Set<number>(opts.avoid ?? []);

  const ephemeral = opts.ephemeralRange;
  const inEphemeral = (p: number) => !!ephemeral && p >= ephemeral.start && p <= ephemeral.end;
  const free = (p: number) => !inEphemeral(p) && !occupied.has(p) && !avoid.has(p);

  // Reuse the persisted port if still free — keeps redeploys on the same target
  // (even if it predates the current range), unless it is an ephemeral port.
  if (
    opts.preferred &&
    !inEphemeral(opts.preferred) &&
    !avoid.has(opts.preferred) &&
    (opts.reuseOccupiedPreferred || !occupied.has(opts.preferred))
  ) {
    return opts.preferred;
  }

  for (let p = start; p <= end; p++) if (free(p)) return p;
  const excludedRange = ephemeral
    ? ` outside ephemeral range ${ephemeral.start}-${ephemeral.end}`
    : "";
  throw new Error(`No free host port available in ${start}-${end}${excludedRange}`);
}

export interface HostPortAllocation {
  port: number;
  /**
   * Live occupancy was actually READ.
   *
   * `false` means the scan produced NO SIGNAL — an executor that cannot reach the
   * host at all is the common cause (a container→host channel dropped by the host
   * firewall, #490). The pick then rests on `avoid` alone, so it can land on a port
   * something else already holds; Docker refuses the bind and the deploy fails with
   * "port is already allocated", which names Docker and not the channel that was
   * really at fault. Callers must SAY so rather than discard this — a scan that
   * failed to run is not the same answer as "nothing is listening".
   */
  scanned: boolean;
}

/**
 * The target's ephemeral port range, from `ip_local_port_range`. Falls back to
 * Linux's default when the file can't be read (an unreachable host, or not Linux).
 */
export async function readEphemeralPortRange(executor: CommandExecutor): Promise<PortRange> {
  const raw = await executor
    .exec("cat /proc/sys/net/ipv4/ip_local_port_range 2>/dev/null || true")
    .catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "adapters/runtime/host-port");
      return "";
    });
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(raw);
  if (!match) return LINUX_EPHEMERAL_RANGE;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start >= 1 && start <= end && end <= 65535 ? { start, end } : LINUX_EPHEMERAL_RANGE;
}

/** Read live occupancy via the target's executor, then pick a free host port. */
export async function allocateHostPort(
  executor: CommandExecutor,
  opts: AllocateHostPortOptions = {},
): Promise<HostPortAllocation> {
  const scan = await scanPorts(executor);
  const occupied = new Set<number>();
  if (scan.scanned) {
    for (const l of scan.listeners) if (l.proto === "tcp") occupied.add(l.port);
  }
  const ephemeralRange = opts.ephemeralRange ?? (await readEphemeralPortRange(executor));
  return { port: pickHostPort(occupied, { ...opts, ephemeralRange }), scanned: scan.scanned };
}
