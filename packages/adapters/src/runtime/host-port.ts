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
}

/** Pure: pick the first port in [start,end] that's neither occupied nor avoided,
 *  reusing `preferred` when it's free. Exported for testing. */
export function pickHostPort(occupied: Set<number>, opts: AllocateHostPortOptions = {}): number {
  const start = opts.rangeStart ?? DEFAULT_RANGE_START;
  const end = opts.rangeEnd ?? DEFAULT_RANGE_END;
  const avoid = new Set<number>(opts.avoid ?? []);
  const free = (p: number) => !occupied.has(p) && !avoid.has(p);

  // Reuse the persisted port if still free — keeps redeploys on the same target
  // (even if it predates the current range).
  if (
    opts.preferred &&
    !avoid.has(opts.preferred) &&
    (opts.reuseOccupiedPreferred || !occupied.has(opts.preferred))
  ) {
    return opts.preferred;
  }

  for (let p = start; p <= end; p++) if (free(p)) return p;
  throw new Error(`No free host port available in ${start}-${end}`);
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
  return { port: pickHostPort(occupied, opts), scanned: scan.scanned };
}
