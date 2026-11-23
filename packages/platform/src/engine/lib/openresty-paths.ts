import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import {
  NginxProvider,
  containerEdgeProvider,
  detectEdgeContainer,
  detectOpenRestyPaths,
  rootOrDegrade,
  resolveOurEdgeContainer,
  type OpenRestyPaths,
} from "@repo/adapters";
import type { CommandExecutor } from "@repo/adapters";
import { AppError } from "@repo/contracts";
import { sshManager } from "./ssh-manager";
import { cacheStore } from "./cache-store/index";
import { resolveEdgeProviderOptions } from "./edge-provider-options";

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
  options: { useServingEdge?: boolean } = {},
): Promise<T> {
  // Fast-fail an unreachable/offline box in ~2.5s instead of paying the full
  // 15-20s SSH-connect timeout (doubled by withExecutor's reconnect retry). This
  // is the single reason the server "Security" tab appeared to hang forever: a
  // GET routing read that blocked on a dead SSH connect with no liveness gate,
  // unlike delete/reconcile which already probe first. probeReachable is instant
  // when a live connection is cached, so the happy path pays nothing.
  const reachable = await sshManager.probeReachable(serverId).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/lib/openresty-paths"); return false; });
  if (!reachable) {
    throw new Error("Server is not reachable over SSH right now.");
  }

  return sshManager.withExecutor(serverId, async (executor) => {
    // Host config reads can still work when the SSH account cannot elevate.
    const edgeExecutor = await rootOrDegrade(executor, {
      purpose: "Editing OpenResty configuration",
      consequence: "Reads still work; a write will fail with the permission error it earns.",
      report: (message) => errorDiagnostics.error("platform/engine/lib/openresty-paths", `[openresty] ${message}`),
    });

    if (options.useServingEdge) {
      const running = await resolveOurEdgeContainer(edgeExecutor, { fresh: true });
      if (running) {
        return fn(
          await containerEdgeProvider(executor, running, await resolveEdgeProviderOptions(serverId)),
        );
      }

      const installed = await detectEdgeContainer(edgeExecutor);
      if (installed?.exists) {
        throw new AppError(
          "The OpenShip edge is installed but unavailable. Check the edge and retry.",
          503,
          "SERVER_EDGE_UNAVAILABLE",
        );
      }
      if (!installed) {
        const docker = await edgeExecutor.exec(
          "if command -v docker >/dev/null 2>&1; then printf present; else printf absent; fi",
        );
        if (docker.trim() !== "absent") {
          throw new AppError(
            "Could not verify which edge serves this server. Check Docker and retry.",
            503,
            "SERVER_EDGE_UNAVAILABLE",
          );
        }
      }
    }

    const run = async (forceRefresh = false) => {
      const paths = await getOpenRestyPaths(serverId, executor, forceRefresh);
      const routing = new NginxProvider({
        ...(await resolveEdgeProviderOptions(serverId)),
        paths,
        executor: edgeExecutor,
      });
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
