/**
 * Server discovery operations — the kernel surface the HTTP API and MCP call
 * (docs/docker-service-discovery-plan.md, step 3 tail).
 *
 * Every operation authorizes SERVER access first ({@link Authorization} on the
 * "server" resource), then works through the engine modules. The heavy lifting
 * stays in the engine: the scanner/reconciler/repair own all route and
 * certificate behavior, the sweep queue owns serialization — `rescan` just
 * enters the same per-server queue as every other trigger, with fresh
 * inventory.
 *
 * Explicit operator intent and its route/certificate retention behavior:
 *   - suppress: the scanner keeps observing (status visibility), no route is
 *     reconciled, and a LIVE route is retired outright (never 503-retained —
 *     explicit control). Certificate material on the server-scoped domain row
 *     is RETAINED (the row stays; re-acceptance reuses it).
 *   - unsuppress: clears the opt-out AND any not-yet-executed retirement, so
     * a change of heart doesn't delete a route the operator decided to keep.
 *   - forget: retires the route NOW (synchronously — a failed removal leaves
 *     the binding intact for retry), then deletes the binding row. The domain
 *     row is deliberately untouched: certificate files, expiry and retry state
 *     survive forgetting a service.
 *   - disable (configure {enabled:false}): schedules retirement for every
 *     applied binding; the reconciler withdraws them outright on its next pass
 *     (the one stage that runs for disabled servers). Watchers expire by
 *     lease. Certificates are retained unless separately forgotten.
 */

import {
  AppError,
  DiscoveryConfigureInputSchema,
  DiscoveryRescanSchema,
  DiscoveryServiceActionInputSchema,
  NotFoundError,
  parseInput,
  type DiscoveryRescan,
  type DiscoveryService,
  type DiscoveryStatus,
} from "@repo/contracts";
import { repos, type DiscoveryBinding } from "@repo/db";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import type { OperationResult } from "./deployments";
import { sweepServerDiscovery } from "./engine/modules/discovery/discovery-sweep";
import {
  retireBindingRoute,
  type DiscoveryEdgeTarget,
} from "./engine/modules/discovery/discovery-reconciler";
import type { DiscoveryBinding as BindingRow } from "@repo/db";

export interface PlatformDiscoveryOperations {
  configure(ctx: ExecutionContext, serverId: string, input: unknown): Promise<OperationResult<DiscoveryStatus>>;
  status(ctx: ExecutionContext, serverId: string): Promise<OperationResult<DiscoveryStatus>>;
  rescan(ctx: ExecutionContext, serverId: string): Promise<OperationResult<DiscoveryRescan>>;
  suppress(ctx: ExecutionContext, serverId: string, input: unknown): Promise<OperationResult<DiscoveryService>>;
  unsuppress(ctx: ExecutionContext, serverId: string, input: unknown): Promise<OperationResult<DiscoveryService>>;
  forget(ctx: ExecutionContext, serverId: string, input: unknown): Promise<OperationResult<{ forgotten: boolean }>>;
}

export function createDiscoveryOperations(authorization: Authorization): PlatformDiscoveryOperations {
  async function authorizeServer(ctx: ExecutionContext, serverId: string, action: "read" | "write" | "admin"): Promise<void> {
    await authorization.authorize(ctx, { resourceType: "server", resourceId: serverId, action });
  }

  function requireBinding(serverId: string, serviceKey: string): Promise<DiscoveryBinding> {
    return (async () => {
      const row = await repos.discovery.getBinding(serverId, serviceKey);
      if (!row) throw new NotFoundError("Discovered service", serviceKey);
      return row;
    })();
  }

  function toService(row: DiscoveryBinding, tls: DiscoveryService["tls"]): DiscoveryService {
    return {
      id: row.id,
      serviceKey: row.serviceKey,
      composeProject: row.composeProject ?? null,
      composeService: row.composeService ?? null,
      hostname: row.hostname,
      port: row.port,
      networkName: row.networkName ?? null,
      observationStatus: row.observationStatus,
      containerName: row.containerName ?? null,
      containerRunning: row.containerRunning,
      upstreamStrategy: row.upstreamStrategy ?? null,
      ipAddress: row.ipAddress ?? null,
      hostPort: row.hostPort !== null ? String(row.hostPort) : null,
      applyState: row.applyState,
      applyError: row.applyError ?? null,
      applyAttempts: row.applyAttempts,
      nextApplyAt: row.nextApplyAt ? row.nextApplyAt.toISOString() : null,
      withdrawalPending: row.withdrawalPending,
      suppressed: row.suppressed,
      desiredGeneration: row.desiredGeneration,
      appliedGeneration: row.appliedGeneration,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      tls,
    };
  }

  async function statusData(ctx: ExecutionContext, serverId: string): Promise<DiscoveryStatus> {
    const settings = await repos.discovery.getSettings(serverId);
    const bindings = await repos.discovery.listByServer(serverId);
    const services: DiscoveryService[] = [];
    for (const row of bindings) {
      const domainRow = await repos.discovery.findDomainForBinding(serverId, row.hostname);
      services.push(
        toService(row, {
          hostname: domainRow?.hostname ?? row.hostname,
          verified: domainRow?.verified ?? false,
          sslStatus: domainRow?.sslStatus ?? "none",
          sslExpiresAt: domainRow?.sslExpiresAt ? domainRow.sslExpiresAt.toISOString() : null,
          sslIssuer: domainRow?.sslIssuer ?? null,
        }),
      );
    }
    void ctx;
    return {
      settings: {
        serverId,
        enabled: settings?.enabled ?? false,
        workspaceId: settings?.workspaceId ?? null,
        sweepIntervalSeconds: settings?.sweepIntervalSeconds ?? 60,
        lastScanAt: settings?.lastScanAt ? settings.lastScanAt.toISOString() : null,
        lastScanError: settings?.lastScanError ?? null,
      },
      services,
    };
  }

  const operations: PlatformDiscoveryOperations = {
    async configure(ctx, serverId, input): Promise<OperationResult<DiscoveryStatus>> {
      await authorizeServer(ctx, serverId, "admin");
      const parsed = parseInput(DiscoveryConfigureInputSchema, input ?? {});
      const settings = await repos.discovery.getSettings(serverId);
      if (!settings && !parsed.enabled) {
        // Configuring nothing to nothing: still a valid no-op state.
      }
      const row = await repos.discovery.configure(serverId, { enabled: parsed.enabled });
      if (!row) throw new AppError("Discovery settings could not be written", 500, "DISCOVERY_CONFIGURE_FAILED");
      if (!parsed.enabled) {
        // Disable: cancel the accelerator (watcher leases expire) and withdraw
        // every applied route — the reconciler's withdrawal stage is the one
        // that runs for disabled servers.
        await repos.discovery.scheduleWithdrawalForAll(serverId);
      }
      return { context: ctx, data: await statusData(ctx, serverId) };
    },

    async status(ctx, serverId): Promise<OperationResult<DiscoveryStatus>> {
      await authorizeServer(ctx, serverId, "read");
      return { context: ctx, data: await statusData(ctx, serverId) };
    },

    async rescan(ctx, serverId): Promise<OperationResult<DiscoveryRescan>> {
      await authorizeServer(ctx, serverId, "write");
      const sweep = await sweepServerDiscovery(serverId, ctx.organizationId, { fresh: true });
      const data: DiscoveryRescan = {
        serverId,
        failed: sweep.failed,
        scan: sweep.scan ? { scanned: sweep.scan.scanned, ok: sweep.scan.ok } : null,
        reconcile: sweep.reconcile
          ? {
              applied: sweep.reconcile.applied,
              removed: sweep.reconcile.removed,
              retained: sweep.reconcile.retained,
              withdrawals: sweep.reconcile.withdrawals,
              failed: sweep.reconcile.failed,
              ok: sweep.reconcile.ok,
            }
          : null,
        repair: sweep.repair ?? null,
      };
      // Validate the shaped output against the published contract before it
      // leaves the kernel, so a drifted summary fails loudly here.
      parseInput(DiscoveryRescanSchema, JSON.parse(JSON.stringify(data)));
      return { context: ctx, data };
    },

    async suppress(ctx, serverId, input): Promise<OperationResult<DiscoveryService>> {
      await authorizeServer(ctx, serverId, "write");
      const { serviceKey } = parseInput(DiscoveryServiceActionInputSchema, input ?? {});
      const binding = await requireBinding(serverId, serviceKey);
      const row = await repos.discovery.suppress(serverId, serviceKey);
      if (!row) throw new NotFoundError("Discovered service", serviceKey);
      void binding;
      return { context: ctx, data: toService(row, await tlsFor(serverId, row)) };
    },

    async unsuppress(ctx, serverId, input): Promise<OperationResult<DiscoveryService>> {
      await authorizeServer(ctx, serverId, "write");
      const { serviceKey } = parseInput(DiscoveryServiceActionInputSchema, input ?? {});
      const row = await repos.discovery.unsuppress(serverId, serviceKey);
      if (!row) throw new NotFoundError("Discovered service", serviceKey);
      return { context: ctx, data: toService(row, await tlsFor(serverId, row)) };
    },

    async forget(ctx, serverId, input): Promise<OperationResult<{ forgotten: boolean }>> {
      await authorizeServer(ctx, serverId, "admin");
      const { serviceKey } = parseInput(DiscoveryServiceActionInputSchema, input ?? {});
      const binding = await requireBinding(serverId, serviceKey);
      // Retire the route FIRST: a failed removal (edge down) leaves the
      // binding intact for a retry instead of stranding a route with no
      // record. Then delete the row; the domain row (certificate material)
      // deliberately survives.
      await retireBindingRoute(serverId, ctx.organizationId, binding);
      await repos.discovery.forget(serverId, serviceKey);
      return { context: ctx, data: { forgotten: true } };
    },
  };
  return Object.freeze(operations);

  async function tlsFor(serverId: string, row: BindingRow): Promise<DiscoveryService["tls"]> {
    const domainRow = await repos.discovery.findDomainForBinding(serverId, row.hostname);
    return {
      hostname: domainRow?.hostname ?? row.hostname,
      verified: domainRow?.verified ?? false,
      sslStatus: domainRow?.sslStatus ?? "none",
      sslExpiresAt: domainRow?.sslExpiresAt ? domainRow.sslExpiresAt.toISOString() : null,
      sslIssuer: domainRow?.sslIssuer ?? null,
    };
  }
}

export type { DiscoveryEdgeTarget };
