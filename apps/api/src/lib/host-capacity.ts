/**
 * What a deploy target actually has — the ceiling for a resource limit.
 *
 * Resource caps used to be validated against hardcoded constants (4 cores /
 * 8192 MB), which meant a 64 GB self-hosted box could not be told to give a
 * container more than 8 GB. The real ceiling is the machine, so we ask it.
 *
 * Source of truth is the Docker daemon's own `/info` (`NCPU`, `MemTotal`):
 * it works identically for the local socket and for a remote daemon over the
 * pooled SSH bridge, and it reports what the daemon can actually allocate. The
 * local host falls back to `os.*` when Docker isn't reachable.
 *
 * SELF-HOSTED ONLY. A cloud (CLOUD_MODE) instance never probes: an Oblien
 * workspace is sized from the tier table, not from host hardware, and the
 * multi-tenant control plane must not open SSH to a tenant's box just to read a
 * number. `getHostCapacity` short-circuits to UNKNOWN there — see the guard
 * below, which is deliberately redundant with the caller's own `isCloud` branch.
 *
 * A probe failure is NOT fatal anywhere. It returns UNKNOWN_CAPACITY, and every
 * consumer treats unknown as "don't enforce a ceiling" — refusing to save a
 * resource change because a box was briefly unreachable would be worse than
 * accepting a number the operator chose deliberately.
 *
 * No shell is involved: `docker info` is an HTTP call on the daemon socket, not
 * an `exec` of an interpolated command string, so there is no injection surface
 * here even though `serverId` is caller-supplied. Server selection is org-scoped
 * by `resolveServerExecutor` (the IDOR guard), so a caller can only ever probe a
 * machine its own organization's project deploys to.
 */

import { UNKNOWN_CAPACITY, type HostCapacity } from "@repo/core";
import { env } from "../config/env";
import { cacheStore } from "./cache-store";
import { createServerDockerRuntime } from "./deployment-runtime";

/** Capacity changes only when hardware does, and this sits on the path of every
 *  resource read — so a few minutes of staleness is free. */
const TTL_SECONDS = 5 * 60;

const NAMESPACE = "host-capacity";

/** In-flight probes, so N concurrent readers open ONE SSH-bridged daemon
 *  connection instead of N. Process-local by design: this dedupes work, the
 *  CacheStore (Redis or memory) holds the result. */
const inflight = new Map<string, Promise<HostCapacity>>();

function cacheKey(serverId: string | undefined, organizationId: string): string {
  return `${organizationId}:${serverId ?? "__default__"}`;
}

/** Docker `/info` → HostCapacity. `NCPU`/`MemTotal` are the daemon's own view
 *  of the host (MemTotal in bytes). */
function fromDockerInfo(info: Record<string, unknown>): HostCapacity | null {
  const ncpu = typeof info.NCPU === "number" ? info.NCPU : 0;
  const memBytes = typeof info.MemTotal === "number" ? info.MemTotal : 0;
  if (ncpu <= 0 && memBytes <= 0) return null;
  return {
    cpuCores: ncpu > 0 ? ncpu : 0,
    memoryMb: memBytes > 0 ? Math.floor(memBytes / (1024 * 1024)) : 0,
    source: "docker",
  };
}

/** This process's own machine. Used for the local host when Docker is
 *  unreachable, and for the desktop/bare topology where there may be no daemon
 *  at all. */
async function fromLocalOs(): Promise<HostCapacity> {
  try {
    const os = await import("node:os");
    const cores = os.cpus()?.length ?? 0;
    const memMb = Math.floor(os.totalmem() / (1024 * 1024));
    if (cores <= 0 && memMb <= 0) return { ...UNKNOWN_CAPACITY };
    return { cpuCores: cores, memoryMb: memMb, source: "local" };
  } catch {
    return { ...UNKNOWN_CAPACITY };
  }
}

async function probe(
  serverId: string | undefined,
  organizationId: string,
  opts: { localFallback: boolean },
): Promise<HostCapacity> {
  let runtime: Awaited<ReturnType<typeof createServerDockerRuntime>> | null = null;
  try {
    runtime = await createServerDockerRuntime(serverId, organizationId);
    const info = await runtime.info();
    const capacity = fromDockerInfo(info);
    if (capacity) return capacity;
  } catch {
    // Unreachable box, no daemon, no server row yet — all non-fatal.
  } finally {
    // MUST dispose: createServerDockerRuntime opens a loopback SSH bridge for
    // remote targets and leaks the listener otherwise.
    await runtime?.dispose?.().catch(() => {});
  }
  return opts.localFallback ? await fromLocalOs() : { ...UNKNOWN_CAPACITY };
}

/**
 * Capacity of the machine a project would deploy to.
 *
 * `serverId` undefined follows the same "org's single server" fallback every
 * server-target deploy takes (resolveServerExecutor owns that rule).
 */
export async function getHostCapacity(
  serverId: string | undefined,
  organizationId: string,
  opts?: { refresh?: boolean; localFallback?: boolean },
): Promise<HostCapacity> {
  // Cloud never probes host hardware. Redundant with the caller's isCloud
  // branch on purpose: this is the hard gate, so a future caller can't
  // accidentally make the multi-tenant control plane dial a tenant's box.
  if (env.CLOUD_MODE) return { ...UNKNOWN_CAPACITY };

  const key = cacheKey(serverId, organizationId);
  const store = await cacheStore<HostCapacity>(NAMESPACE, { maxSize: 500 });

  if (!opts?.refresh) {
    const hit = await store.get(key);
    if (hit) return hit;
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const run = probe(serverId, organizationId, {
    localFallback: opts?.localFallback ?? true,
  })
    .then(async (value) => {
      // Only cache a real answer. Caching "unknown" for the full TTL would keep
      // enforcing no-ceiling long after the box came back.
      if (value.source !== "unknown") {
        await store.set(key, value, TTL_SECONDS).catch(() => {});
      }
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, run);
  return run;
}

/** Drop cached capacity for a server (or a whole org). Call after a server is
 *  resized/removed so the next read re-probes. */
export async function invalidateHostCapacity(
  organizationId: string,
  serverId?: string,
): Promise<void> {
  const store = await cacheStore<HostCapacity>(NAMESPACE, { maxSize: 500 });
  if (serverId) {
    inflight.delete(cacheKey(serverId, organizationId));
    await store.delete(cacheKey(serverId, organizationId));
    return;
  }
  // Whole org — the shared Redis namespace makes the prefix scan safe.
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(`${organizationId}:`)) inflight.delete(key);
  }
  await store.invalidateByPrefix(`${organizationId}:`);
}
