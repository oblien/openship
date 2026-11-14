/**
 * Discovery sweep wiring (docs/docker-service-discovery-plan.md, step 5).
 *
 * ONE recurring job drives the whole discovery lifecycle for every enabled
 * server, every minute (the plan's "60-second repair sweep"; per-server
 * `sweepIntervalSeconds` can stretch only the SCAN — reconcile and repair run
 * every tick, they are DB-driven and cheap):
 *
 *   scan (inventory → desired state) → reconcile (routes + withdrawals +
 *   retention) → repair (durable-record route files).
 *
 * Stage isolation: a failed scan must not block reconciliation of the state
 * already recorded (the scanner's own errors are visible retry states), and a
 * failed reconcile must not block repair of route files. A failed server never
 * blocks the others.
 *
 * `startDiscoverySweep` registers the job on the shared runner (job_run
 * history via scheduleSystemJob) AND runs one sweep immediately — the
 * plan's startup inventory: discovery state converges at boot without
 * waiting for the first tick. The lifecycle-event watcher
 * (`discovery-watch.ts`) renews from the sweep itself, so it also arms here.
 */

import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import { scheduleSystemJob, type JobSummary } from "../../lib/system-jobs";
import { trackBackgroundWork } from "../../lib/background-work";
import { scanServerDiscovery, type DiscoveryScanSummary } from "./discovery-scanner";
import {
  reconcileServerDiscovery,
  type DiscoveryReconcileSummary,
} from "./discovery-reconciler";
import { repairDiscoveryRoutes, type DiscoveryRepairSummary } from "./discovery-repair";
import { renewDiscoveryWatchers } from "./discovery-watch";

export const DISCOVERY_SWEEP_JOB = "discovery:sweep";

/** Per-stage summaries for one server's sweep. */
export interface DiscoveryServerSweepSummary {
  serverId: string;
  scan?: DiscoveryScanSummary;
  reconcile?: DiscoveryReconcileSummary;
  repair?: DiscoveryRepairSummary;
  /** Stages that threw (their key is absent from the summary). */
  failed: Array<"scan" | "reconcile" | "repair">;
}

/**
 * ONE queue per server: the startup inventory, the cron tick, and every
 * event-triggered pass serialize through it. Without this, an older pass can
 * read pre-event state and withdraw or replace a route a newer pass just
 * wrote — scan→reconcile is a read-modify-write cycle and must not overlap
 * itself for one server. Different servers still sweep independently.
 */
const serverSweepQueues = new Map<string, Promise<DiscoveryServerSweepSummary>>();

export interface DiscoverySweepSummary {
  servers: number;
  failed: string[];
  details: DiscoveryServerSweepSummary[];
}

/**
 * Run scan → reconcile → repair for ONE enabled server, SERIALIZED through the
 * per-server queue (startup, cron, and event triggers all enter here). Every
 * stage is individually error-isolated; the summary reports which stages
 * failed.
 *
 * `fresh` bypasses the per-server scan interval. It is REQUIRED for triggers
 * whose whole point is current state — the startup inventory, and every
 * lifecycle event (a stop event just after a scan must not reconcile cached
 * state). Only the recurring cron poll applies the interval.
 */
export async function sweepServerDiscovery(
  serverId: string,
  organizationId: string,
  options?: { fresh?: boolean },
): Promise<DiscoveryServerSweepSummary> {
  const tail = serverSweepQueues.get(serverId);
  const run = (tail ?? Promise.resolve<DiscoveryServerSweepSummary>({ serverId, failed: [] }))
    .catch(() => undefined)
    .then(() => runServerSweep(serverId, organizationId, options));
  serverSweepQueues.set(serverId, run);
  // Drop the queue entry once this run is the tail — otherwise the map grows
  // by one entry per server forever. The cleanup observes BOTH outcomes: a
  // bare `run.finally(...)` would discard a rejecting promise (an unhandled
  // rejection even when the caller catches `run` itself — reproduced with a
  // failing settings read), while then(onFulfilled, onRejected) settles the
  // cleanup chain quietly and leaves `run`'s rejection to the caller's catch.
  const dropQueueEntry = (): void => {
    if (serverSweepQueues.get(serverId) === run) serverSweepQueues.delete(serverId);
  };
  void run.then(dropQueueEntry, dropQueueEntry);
  return run;
}

async function runServerSweep(
  serverId: string,
  organizationId: string,
  options?: { fresh?: boolean },
): Promise<DiscoveryServerSweepSummary> {
  const summary: DiscoveryServerSweepSummary = { serverId, failed: [] };

  // Honor the per-server scan interval — for the recurring poll only (see the
  // `fresh` option): a server configured to rescan less often skips its
  // inventory when the last scan is fresh. Reconcile and repair ALWAYS run —
  // they are DB-driven and cheap, and a reconcile that clears the apply queue
  // must not wait on a stretched scan cadence.
  const settings = await repos.discovery.getSettings(serverId);
  const scanDue =
    options?.fresh === true ||
    !settings?.lastScanAt ||
    Date.now() - settings.lastScanAt.getTime() >= Math.max(0, (settings?.sweepIntervalSeconds ?? 60) - 5) * 1000;
  if (scanDue) {
    try {
      summary.scan = await scanServerDiscovery(serverId, organizationId);
      if (!summary.scan.ok) summary.failed.push("scan");
    } catch (error) {
      errorDiagnostics.warn(
        "platform/engine/modules/discovery/discovery-sweep",
        `[discovery-sweep] scan failed for ${serverId}: ${safeErrorMessage(error)}`,
      );
      summary.failed.push("scan");
    }
  }

  try {
    summary.reconcile = await reconcileServerDiscovery(serverId, organizationId);
    if (!summary.reconcile.ok) summary.failed.push("reconcile");
  } catch (error) {
    errorDiagnostics.warn(
      "platform/engine/modules/discovery/discovery-sweep",
      `[discovery-sweep] reconcile failed for ${serverId}: ${safeErrorMessage(error)}`,
    );
    summary.failed.push("reconcile");
  }

  try {
    summary.repair = await repairDiscoveryRoutes(serverId, organizationId);
  } catch (error) {
    errorDiagnostics.warn(
      "platform/engine/modules/discovery/discovery-sweep",
      `[discovery-sweep] repair failed for ${serverId}: ${safeErrorMessage(error)}`,
    );
    summary.failed.push("repair");
  }

  return summary;
}

/**
 * One sweep across every sweepable server: enabled ones, PLUS disabled
 * servers still owing route withdrawals (disable scheduled retirement —
 * reconcile must run for them; scan/apply/repair self-gate on `enabled`).
 * `fresh` (startup inventory) forces fresh inventory on every server; the
 * recurring cron body calls without it.
 */
export async function sweepDiscovery(options?: { fresh?: boolean }): Promise<DiscoverySweepSummary> {
  const summary: DiscoverySweepSummary = { servers: 0, failed: [], details: [] };
  let enabled: Array<{ serverId: string }>;
  try {
    enabled = await repos.discovery.listSweepableServerIds();
  } catch (error) {
    errorDiagnostics.warn(
      "platform/engine/modules/discovery/discovery-sweep",
      `[discovery-sweep] could not list sweepable servers: ${safeErrorMessage(error)}`,
    );
    return summary;
  }
  summary.servers = enabled.length;

  for (const { serverId } of enabled) {
    try {
      const server = await repos.server.get(serverId);
      if (!server?.organizationId) {
        // Orphaned settings or a server without a tenant: nothing org-scoped
        // (runtime, domains, TLS) can resolve. The scanner would say the same.
        summary.failed.push(serverId);
        continue;
      }
      const detail = await sweepServerDiscovery(serverId, server.organizationId, options);
      summary.details.push(detail);
      if (detail.failed.length > 0) summary.failed.push(serverId);
    } catch (error) {
      errorDiagnostics.warn(
        "platform/engine/modules/discovery/discovery-sweep",
        `[discovery-sweep] server ${serverId} sweep failed: ${safeErrorMessage(error)}`,
      );
      summary.failed.push(serverId);
    }
  }

  // Watcher lease renewal rides the sweep (see discovery-watch): ENABLED
  // servers keep their lifecycle-event subscriptions — a disabled server's
  // watcher lease expires itself (disable "cancels watchers"). Owing-only
  // disabled servers never arm.
  const enabledIds: string[] = [];
  for (const detail of summary.details) {
    const settings = await repos.discovery.getSettings(detail.serverId).catch(() => null);
    if (settings?.enabled) enabledIds.push(detail.serverId);
  }
  await renewDiscoveryWatchers(enabledIds).catch((error) => {
    errorDiagnostics.warn(
      "platform/engine/modules/discovery/discovery-sweep",
      `[discovery-sweep] watcher renewal failed: ${safeErrorMessage(error)}`,
    );
  });
  return summary;
}

/**
 * Register the recurring sweep and run the startup inventory immediately.
 * Idempotent per job id. Called from API startup (self-hosted).
 */
export async function startDiscoverySweep(): Promise<void> {
  await scheduleSystemJob({
    jobId: DISCOVERY_SWEEP_JOB,
    cronExpression: "* * * * *", // every minute = the plan's 60-second sweep
    run: async (): Promise<JobSummary> => {
      const summary = await sweepDiscovery(); // cron poll: interval-gated
      return {
        servers: summary.servers,
        failed: summary.failed.length,
        repaired: summary.details.reduce((n, d) => n + (d.repair?.repaired.length ?? 0), 0),
        retained: summary.details.reduce((n, d) => n + (d.repair?.retained.length ?? 0), 0),
        requeued: summary.details.reduce((n, d) => n + (d.repair?.requeued.length ?? 0), 0),
      };
    },
  });
  // Startup inventory: converge now, don't wait for the first tick, with
  // FRESH inventory (the interval gate is a poll-cadence tool, not a startup
  // one). The watcher subscriptions arm inside the sweep's renewal.
  void trackBackgroundWork(
    sweepDiscovery({ fresh: true }).catch((error) => {
      errorDiagnostics.warn(
        "platform/engine/modules/discovery/discovery-sweep",
        `[discovery-sweep] startup inventory failed: ${safeErrorMessage(error)}`,
      );
    }),
  );
}
