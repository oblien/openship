/**
 * Existing proxy routes, including their upstream addresses, source proxy and
 * discovery notices. The adapter owns parsing/indexing; this wrapper supplies
 * the executor for the selected server. Reconciliation can match both private
 * Docker addresses and published host ports without confusing shared ports.
 *
 * Read-only; never throws (a scan failure must not fail discovery).
 */

import { buildProxyRouteIndex, edgeProxy } from "@repo/adapters";
import type { CommandExecutor, ProxySiteRoute, ProxyKind } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { withMigrationExecution } from "./migration-runtime";

/** @deprecated Use `ProxySiteRoute` from `@repo/adapters`. Kept so existing
 *  migration callers (docker-reconcile, docker-inspect) don't churn. */
export type ExistingRoute = ProxySiteRoute;
export type ExistingRouteSsl = ProxySiteRoute["ssl"];

export interface ProxyRouteScan {
  routesByPort: Map<number, ExistingRoute[]>;
  proxy?: { kind: ProxyKind; container: string | null; ours: boolean };
  warnings: string[];
}

function failedScan(error: unknown): ProxyRouteScan {
  return {
    routesByPort: new Map(),
    warnings: [`Could not inspect the existing reverse proxy: ${safeErrorMessage(error)}. Review the routes before migrating.`],
  };
}

export async function scanProxyRoutes(serverId: string, organizationId: string): Promise<ProxyRouteScan> {
  try {
    return await withMigrationExecution(serverId, organizationId, scanProxyRoutesWithExecutor);
  } catch (error) {
    return failedScan(error);
  }
}

/**
 * Executor-scoped core of {@link scanProxyRoutes}. Split out so callers that
 * already hold the right host executor can scan without another connection.
 * Failures remain visible as discovery notices.
 */
export async function scanProxyRoutesWithExecutor(
  exec: CommandExecutor,
): Promise<ProxyRouteScan> {
  try {
    const proxy = await edgeProxy(exec);
    if (!proxy) return { routesByPort: new Map(), warnings: [] };
    const scan = await proxy.listSites();
    return {
      routesByPort: buildProxyRouteIndex(scan.sites),
      proxy: { kind: proxy.kind, container: proxy.container, ours: proxy.ours },
      warnings: scan.warnings,
    };
  } catch (error) {
    return failedScan(error);
  }
}
