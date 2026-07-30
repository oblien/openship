/**
 * Routes the server's existing reverse proxy already serves, indexed by the
 * published host port it forwards to — the join key the migrate wizard uses to
 * attach each container's current domain(s) + SSL and offer to keep them.
 *
 * The parsing, indexing, and cert reading all live in the adapter's proxy read api
 * (`edgeProxy`) now. This file is the SSH-bound wrapper: it resolves an executor
 * for a serverId and delegates. It used to own `buildProxyRouteIndex` itself, which
 * meant anything needing a by-port view — including cert reuse in the domains
 * module — had to import from `../migration/`.
 *
 * Read-only; never throws (a scan failure must not fail discovery).
 */

import { edgeProxy } from "@repo/adapters";
import type { CommandExecutor, ProxySiteRoute } from "@repo/adapters";
import { sshManager } from "../../lib/ssh-manager";

/** @deprecated Use `ProxySiteRoute` from `@repo/adapters`. Kept so existing
 *  migration callers (docker-reconcile, docker-inspect) don't churn. */
export type ExistingRoute = ProxySiteRoute;
export type ExistingRouteSsl = ProxySiteRoute["ssl"];

export async function scanProxyRoutes(serverId: string): Promise<Map<number, ExistingRoute[]>> {
  try {
    return await sshManager.withExecutor(serverId, scanProxyRoutesWithExecutor);
  } catch {
    return new Map<number, ExistingRoute[]>();
  }
}

/**
 * Executor-scoped core of {@link scanProxyRoutes}. Split out so callers that
 * already hold the right host executor — e.g. cert reuse on the auto-registered
 * LOCAL host-server, where `sshManager` (SSH-only) can't connect — can scan the
 * edge on `createHostExecutor()` instead. Never throws; empty map on any failure.
 */
export async function scanProxyRoutesWithExecutor(
  exec: CommandExecutor,
): Promise<Map<number, ExistingRoute[]>> {
  try {
    const proxy = await edgeProxy(exec);
    return (await proxy?.sitesByPort()) ?? new Map<number, ExistingRoute[]>();
  } catch {
    return new Map<number, ExistingRoute[]>();
  }
}
