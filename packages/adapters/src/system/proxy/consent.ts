/**
 * Edge-ownership consent gate — decides how to make ports 80/443 ours to bind
 * without ever blind-killing a foreign proxy. Lives with the rest of the edge
 * module (not in the generic component installer): `ensureContainerEdge` calls this
 * before it stops or starts anything.
 */

import { AppError } from "@repo/core";
import type { CommandExecutor } from "../../types";
import type {
  EdgeConflictDetails,
  EdgeStatus,
  InstallerConfig,
  SystemLog,
  SystemLogCallback,
} from "../types";
import { EdgeConflictError, EdgeMigrateRequested, probeEdge } from "./detect";
import { beginEdgeTakeover, rollbackEdgeTakeover } from "./takeover-journal";
import { importSites } from "./index";

function log(message: string, level: SystemLog["level"] = "info"): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}

/**
 * Make ports 80/443 ours to bind — without ever blind-killing a foreign proxy.
 *
 * Resolution order:
 *   1. free / ours              → proceed.
 *   2. pre-accepted edgePolicy  → stop the identified targets (no prompt).
 *   3. interactive promptUser   → HOLD and ask (same mechanism as the deploy
 *      "a service is already running" prompt): "override" stops it and takes
 *      over; "cancel" aborts. ("migrate" is signalled to the caller.)
 *   4. neither                  → throw EdgeConflictError (never guess).
 *
 * Whatever holds the ports goes through here, INCLUDING a deprecated bare-host
 * OpenResty an older Openship installed: the edge is a container now, so a host
 * OpenResty is a proxy to migrate from like any other. There is no second
 * "decommission the legacy edge" path — a second path is precisely how this gate got
 * bypassed (detect called that proxy "ours", so `canProceedClean` was true and we
 * returned without stopping anything, then the edge container crash-looped on
 * `bind() … (98: Address already in use)` while every surface reported success).
 *
 * Returns the probe alongside the decision so the caller doesn't re-run `probeEdge`
 * (several shell-outs per port) and act on a second, possibly different answer.
 */
export async function ensureEdgeClear(
  executor: CommandExecutor,
  config: InstallerConfig | undefined,
  onLog: SystemLogCallback,
): Promise<{ tookOver: boolean; status: EdgeStatus }> {
  const status = await probeEdge(executor);
  if (status.canProceedClean) return { tookOver: false, status };

  // Journaled, and proven. `beginEdgeTakeover` snapshots how to restore what it's
  // about to stop (so the caller's failure path can put it back, and so a crash
  // mid-flight is repaired at next boot by `recoverInterruptedTakeover`) and then
  // waits for the sockets to be RELEASED. Throwing when they aren't is the point:
  // issuing a stop is not the same fact as ":80 is bindable", and every caller that
  // conflated them started a container that lost the race and then reported success
  // because `docker run` exited 0.
  const takeover = async () => {
    onLog(log(
      `Taking over ports from ${status.occupants.map((o) => o.command ?? o.port).join(", ")}...`,
      "warn",
    ));
    const freed = await beginEdgeTakeover(
      executor,
      status,
      onLog,
      config?.edgePolicy?.stopTargets ?? [],
    );
    if (!freed.freed) {
      // We stopped it and it didn't let go — so put it back before failing. This is
      // OUR postcondition to honor: the caller hasn't started anything yet and has no
      // journal of its own, so nobody downstream can undo this.
      await rollbackEdgeTakeover(executor, onLog);
      const plural = freed.stillBound.length > 1;
      throw new AppError(
        `Stopped the existing proxy, but port${plural ? "s" : ""} ${freed.stillBound.join(" and ")} ` +
          `${plural ? "are" : "is"} still in use, so the edge can't bind. Nothing was installed and ` +
          "the previous proxy has been restored — find what else is holding the port and retry.",
        409,
        "EDGE_PORTS_STILL_BOUND",
      );
    }
  };

  if (config?.edgePolicy?.mode === "takeover") {
    await takeover();
    return { tookOver: true, status };
  }

  if (config?.promptUser) {
    const known = status.classification === "known";
    const owner = status.occupants.map((o) => o.command ?? `port ${o.port}`).join(", ");

    // Scan the foreign proxy's sites (empty unless it's an importable kind) so
    // we can offer migration. Single source: proxy/importSites.
    const scan = await importSites(executor, status);
    const migratable = scan.sites.length > 0;

    // Openship terminates TLS + routes on its own OpenResty edge, so it must own
    // 80/443. Spell that out — the operator is choosing to hand their load
    // balancer to us, and "migrate" imports the existing sites first so nothing
    // they're serving goes dark.
    const message = migratable
      ? `Openship runs its own load balancer (OpenResty) on ports 80 and 443, but ${owner} is ` +
        `already serving them (${scan.sites.length} site${scan.sites.length === 1 ? "" : "s"}). ` +
        `Migrate those sites into Openship and take over, just stop it and take over, or cancel?`
      : known
        ? `Openship runs its own load balancer (OpenResty) on ports 80 and 443, but ${owner} is ` +
          `already serving them. Stop it and take over, or cancel and leave it running?`
        : `Openship runs its own load balancer (OpenResty) on ports 80 and 443, but ${owner} is ` +
          `already using them and we can't identify it. Stop it and take over, or cancel and leave it running?`;

    const details: EdgeConflictDetails = {
      edge: status,
      sites: scan.sites,
      warnings: scan.warnings,
    };
    const action = await config.promptUser({
      promptId: "edge_conflict",
      title: known ? "Existing reverse proxy detected" : "Ports 80/443 are in use",
      message,
      actions: [
        ...(migratable
          ? [{ id: "migrate", label: `Migrate ${scan.sites.length} site(s) & take over`, variant: "primary" }]
          : []),
        { id: "override", label: "Stop it & take over", variant: "danger" },
        { id: "cancel", label: "Cancel", variant: "secondary" },
      ],
      details,
    });

    if (action === "migrate") {
      throw new EdgeMigrateRequested(status, scan.sites, scan.warnings);
    }
    if (action === "override") {
      await takeover();
      return { tookOver: true, status };
    }
    // "cancel" (or anything unexpected) → leave the box untouched.
    throw new EdgeConflictError(status);
  }

  throw new EdgeConflictError(status);
}
