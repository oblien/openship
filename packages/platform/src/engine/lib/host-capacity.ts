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
 * Provider workspaces use their purchased capacity. Customer-owned servers use
 * the same authorized SSH probe in hosted Manage and self-hosted installations.
 * The SaaS control plane is never a local fallback.
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

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { UNKNOWN_CAPACITY, type HostCapacity } from "@repo/core";
import { env } from "../config/env";
import { isCustomerServer } from "../modules/billing/management.service";
import { cacheStore } from "./cache-store/index";
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

/**
 * GPU signals in Docker `/info`, with no shell on the host.
 *
 *  - `Runtimes` is a map of registered container runtimes; an `nvidia` key means the NVIDIA Container
 *    Toolkit is installed and registered — exactly what `DeviceRequests` needs on this daemon.
 *  - `DiscoveredDevices` (Docker >= 28) lists CDI devices such as `nvidia.com/gpu=0`; counting them is
 *    the only way to learn the number of cards without exec'ing `nvidia-smi`.
 *
 * Returns only the keys it actually learned: an older daemon that lists no devices must leave
 * `gpuCount` absent (unknown), not 0 (none).
 */
export function gpuFromDockerInfo(
  info: Record<string, unknown>,
): Pick<HostCapacity, "gpuRuntime" | "gpuCount"> {
  const out: Pick<HostCapacity, "gpuRuntime" | "gpuCount"> = {};
  const runtimes = info.Runtimes;
  if (runtimes && typeof runtimes === "object" && !Array.isArray(runtimes)) {
    out.gpuRuntime = "nvidia" in (runtimes as Record<string, unknown>);
  }
  const discovered = info.DiscoveredDevices;
  if (Array.isArray(discovered)) {
    // CDI names ONE card several ways: by index (`gpu=0`), by UUID (`gpu=GPU-86fe…`) and the set alias
    // (`gpu=all`). Measured on a single Tesla T4: three entries, one card. Counting entries would triple
    // it, so count only index-named entries; the UUID/`all` spellings add nothing. (MIG instances are
    // named `0:0`; they are not whole cards and are left out on purpose.)
    const indexes = discovered
      .map((d) => (d && typeof d === "object" ? (d as Record<string, unknown>).ID : undefined))
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.match(/^nvidia\.com\/gpu=(\d+)$/i)?.[1])
      .filter((i): i is string => i !== undefined);
    if (indexes.length > 0) out.gpuCount = new Set(indexes).size;
  }
  return out;
}

/** Docker `/info` → HostCapacity. `NCPU`/`MemTotal` are the daemon's own view
 *  of the host (MemTotal in bytes). */
export function fromDockerInfo(info: Record<string, unknown>): HostCapacity | null {
  const ncpu = typeof info.NCPU === "number" ? info.NCPU : 0;
  const memBytes = typeof info.MemTotal === "number" ? info.MemTotal : 0;
  if (ncpu <= 0 && memBytes <= 0) return null;
  return {
    cpuCores: ncpu > 0 ? ncpu : 0,
    memoryMb: memBytes > 0 ? Math.floor(memBytes / (1024 * 1024)) : 0,
    source: "docker",
    ...gpuFromDockerInfo(info),
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
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/lib/host-capacity");
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
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/lib/host-capacity");
    // Unreachable box, no daemon, no server row yet — all non-fatal.
  } finally {
    // MUST dispose: createServerDockerRuntime opens a loopback SSH bridge for
    // remote targets and leaks the listener otherwise.
    await runtime?.dispose?.().catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "platform/engine/lib/host-capacity");
    });
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
  if (env.CLOUD_MODE && !await isCustomerServer(organizationId, serverId)) return { ...UNKNOWN_CAPACITY };

  const key = cacheKey(serverId, organizationId);
  const store = await cacheStore<HostCapacity>(NAMESPACE, { maxSize: 500 });

  if (!opts?.refresh) {
    const hit = await store.get(key);
    if (hit) return hit;
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const run = probe(serverId, organizationId, {
    localFallback: !env.CLOUD_MODE && (opts?.localFallback ?? true),
  })
    .then(async (value) => {
      // Only cache a real answer. Caching "unknown" for the full TTL would keep
      // enforcing no-ceiling long after the box came back.
      if (value.source !== "unknown") {
        await store.set(key, value, TTL_SECONDS).catch((diagnosticFailure) => {
          observeCaughtError(diagnosticFailure, "platform/engine/lib/host-capacity");
        });
      }
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, run);
  return run;
}

/**
 * Capacity, but only when the reading actually describes the machine asked about.
 *
 * The fallback above is deliberate for a resource CEILING (a number the operator
 * typed is better accepted than blocked), yet wrong for a decision that can
 * REFUSE: `probe` falls back to this API host's own `os.*`, and the cache is
 * keyed org+serverId, so a `source: "local"` reading can legitimately come back
 * for a remote box whose daemon was briefly unreachable. Believing it would match
 * an app's requirement against the orchestrator's RAM and refuse a deploy to a
 * 64 GB server. A `local` number is the truth only when the deploy lands here.
 *
 * Anything else collapses to UNKNOWN, which every consumer treats as "don't
 * enforce" — the one safe direction for a check that can say no.
 */
export async function getTrustedHostCapacity(
  serverId: string | undefined,
  organizationId: string,
  opts: { isLocalTarget: boolean },
): Promise<HostCapacity> {
  const capacity = await getHostCapacity(serverId, organizationId, {
    localFallback: opts.isLocalTarget,
  }).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/lib/host-capacity"); return ({ ...UNKNOWN_CAPACITY }); });
  if (capacity.source === "docker") return capacity;
  if (capacity.source === "local" && opts.isLocalTarget) return capacity;
  return { ...UNKNOWN_CAPACITY };
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
