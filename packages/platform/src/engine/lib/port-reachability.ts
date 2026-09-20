/**
 * Off-box TCP reachability from the Openship API host.
 *
 * A listener scan only proves that a process bound a socket on the target. This
 * module owns the second half of that answer: can the control plane actually
 * establish a TCP connection to the target address? Keeping the bounded worker
 * pool here gives the Security scan and feature-specific health checks one probe
 * implementation and one set of resource limits.
 */

import { probeTcpDetailed, type PortScanResult, type TcpProbeResult } from "@repo/adapters";

export interface PortReachabilityOptions {
  timeoutMs?: number;
  concurrency?: number;
  maxPorts?: number;
  probe?: (host: string, port: number, timeoutMs: number) => Promise<TcpProbeResult>;
}

export interface PortReachabilityObservation {
  port: number;
  result: TcpProbeResult;
}

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_CONCURRENCY = 16;
const DEFAULT_MAX_PORTS = 50;

export function isRemoteDialTarget(host: string | null | undefined): host is string {
  if (!host?.trim()) return false;
  return !/^(127\.|::1$|localhost$)/i.test(host.trim());
}

/**
 * Probe a bounded, de-duplicated set of TCP ports in parallel.
 *
 * The detailed socket failure is preserved: callers such as mail health need to
 * distinguish a dropped SYN (`timeout`) from a reachable host with no listener
 * (`refused`) instead of flattening both into the same diagnosis.
 */
export async function probePortsFromControlPlane(
  host: string,
  ports: readonly number[],
  options: PortReachabilityOptions = {},
): Promise<PortReachabilityObservation[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPorts = Math.max(0, options.maxPorts ?? DEFAULT_MAX_PORTS);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const probe = options.probe ?? probeTcpDetailed;
  const queue = [
    ...new Set(ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535)),
  ].slice(0, maxPorts);
  const observations = new Map<number, TcpProbeResult>();

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let port = queue.shift(); port !== undefined; port = queue.shift()) {
      const result = await probe(host.trim(), port, timeoutMs).catch((err: unknown) => ({
        ok: false as const,
        reason: "error" as const,
        message: err instanceof Error ? err.message : "TCP probe failed",
      }));
      observations.set(port, result);
    }
  });
  await Promise.all(workers);

  return [...observations.entries()]
    .sort(([a], [b]) => a - b)
    .map(([port, result]) => ({ port, result }));
}

/**
 * Add off-box reachability to a host listener scan.
 *
 * This is the shared implementation used by the Server Security tab. Feature
 * health modules should call `probePortsFromControlPlane` directly when they
 * need the detailed failure reason as part of their public contract.
 */
export async function confirmPortScanReachability(
  result: PortScanResult,
  host: string | null,
  options: PortReachabilityOptions = {},
): Promise<PortScanResult> {
  if (!result.scanned || !isRemoteDialTarget(host)) {
    return { ...result, reachabilityProbed: false, reachableCount: 0 };
  }

  const targets = result.listeners
    .filter((listener) => listener.exposed && listener.proto === "tcp")
    .map((listener) => listener.port);
  const observations = await probePortsFromControlPlane(host, targets, options);
  const reachable = new Map(observations.map(({ port, result }) => [port, result.ok]));
  const listeners = result.listeners.map((listener) =>
    listener.exposed && listener.proto === "tcp" && reachable.has(listener.port)
      ? { ...listener, reachable: reachable.get(listener.port)! }
      : listener,
  );

  return {
    ...result,
    listeners,
    reachabilityProbed: true,
    reachableCount: listeners.filter((listener) => listener.reachable === true).length,
  };
}
