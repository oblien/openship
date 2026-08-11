/**
 * Edge-ownership consent gate — decides how to make ports 80/443 ours to bind
 * without ever blind-killing a foreign proxy. Lives with the rest of the edge
 * module (not in the generic component installer): `installOpenResty` calls this
 * at the top of its run.
 */

import type { CommandExecutor } from "../../types";
import type { EdgeConflictDetails, InstallerConfig, SystemLog, SystemLogCallback } from "../types";
import {
  EdgeConflictError,
  EdgeMigrateRequested,
  freeEdgeTargets,
  probeEdge,
  stopTargetsForStatus,
} from "./detect";
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
 */
export async function ensureEdgeClear(
  executor: CommandExecutor,
  config: InstallerConfig | undefined,
  onLog: SystemLogCallback,
): Promise<{ tookOver: boolean }> {
  const status = await probeEdge(executor);
  if (status.canProceedClean) return { tookOver: false };

  const takeover = async () => {
    onLog(log(
      `Taking over ports from ${status.occupants.map((o) => o.command ?? o.port).join(", ")}...`,
      "warn",
    ));
    const configured = config?.edgePolicy?.stopTargets ?? [];
    const targets = configured.length ? configured : stopTargetsForStatus(status);
    await freeEdgeTargets(executor, targets, (m, l) => onLog(log(m, l)));
  };

  if (config?.edgePolicy?.mode === "takeover") {
    await takeover();
    return { tookOver: true };
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
      return { tookOver: true };
    }
    // "cancel" (or anything unexpected) → leave the box untouched.
    throw new EdgeConflictError(status);
  }

  throw new EdgeConflictError(status);
}
