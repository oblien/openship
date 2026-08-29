import {
  NginxProvider,
  detectOpenRestyPaths,
  rootOrDegrade,
  type OpenRestyPaths,
} from "@repo/adapters";
import type { CommandExecutor } from "@repo/adapters";
import { sshManager } from "./ssh-manager";
import { cacheStore } from "./cache-store";

// 1h TTL — OpenResty path layout is effectively immutable per server,
// but cap it so a redeploy that moves nginx is caught within the hour.
const OPENRESTY_PATH_TTL_S = 60 * 60;

export async function getOpenRestyPaths(
  serverId: string,
  executor: CommandExecutor,
  forceRefresh = false,
): Promise<OpenRestyPaths> {
  const store = await cacheStore<OpenRestyPaths>("openresty-paths");
  if (!forceRefresh) {
    const cached = await store.get(serverId);
    if (cached) return cached;
  }
  const detected = await detectOpenRestyPaths(executor);
  await store.set(serverId, detected, OPENRESTY_PATH_TTL_S);
  return detected;
}

export async function invalidateOpenRestyPaths(serverId?: string): Promise<void> {
  const store = await cacheStore<OpenRestyPaths>("openresty-paths");
  if (serverId) {
    await store.delete(serverId);
    return;
  }
  await store.invalidateByPrefix("");
}

export async function withOpenRestyRouting<T>(
  serverId: string,
  fn: (routing: NginxProvider) => Promise<T>,
): Promise<T> {
  // Fast-fail an unreachable/offline box in ~2.5s instead of paying the full
  // 15-20s SSH-connect timeout (doubled by withExecutor's reconnect retry). This
  // is the single reason the server "Security" tab appeared to hang forever: a
  // GET routing read that blocked on a dead SSH connect with no liveness gate,
  // unlike delete/reconcile which already probe first. probeReachable is instant
  // when a live connection is cached, so the happy path pays nothing.
  const reachable = await sshManager.probeReachable(serverId).catch(() => false);
  if (!reachable) {
    throw new Error("Server is not reachable over SSH right now.");
  }

  return sshManager.withExecutor(serverId, async (executor) => {
    // `applyRateLimit` — the one write behind this helper — edits the root-owned
    // nginx.conf, and this path never asked for privilege, so a non-root login got an
    // EACCES rendered as "Failed to update OpenResty rate limit config". Elevated when
    // the box allows it; degraded (not refused) when it doesn't, because the READS here
    // work unelevated today on a world-readable nginx.conf and refusing would take the
    // Security tab away from boxes where it currently works.
    const edgeExecutor = await rootOrDegrade(executor, {
      purpose: "Editing OpenResty configuration",
      consequence: "Reads still work; a write will fail with the permission error it earns.",
      report: (message) => console.error(`[openresty] ${message}`),
    });

    const run = async (forceRefresh = false) => {
      const paths = await getOpenRestyPaths(serverId, executor, forceRefresh);
      const routing = new NginxProvider({ paths, executor: edgeExecutor });
      return fn(routing);
    };

    try {
      return await run(false);
    } catch (err) {
      const store = await cacheStore<OpenRestyPaths>("openresty-paths");
      if (!(await store.get(serverId))) throw err;
      await store.delete(serverId);
      return run(true);
    }
  });
}