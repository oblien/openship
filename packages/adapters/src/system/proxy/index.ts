/**
 * The reverse-proxy / edge module — the single surface for the
 * prepare → detect → import → consent → takeover chain.
 *
 * Callers should reach for THIS module rather than re-assembling the chain out
 * of edge-preflight / proxy-import / edge-takeover themselves (which is how the
 * same triad and migrate-catch ended up copy-pasted across the deploy pipeline,
 * server-setup, the self-app, and mail). It re-exports the engine pieces and
 * adds the consolidated entrypoints.
 */

import type { CommandExecutor } from "../../types";
import type { EdgeStatus, ProxyScanResult, SystemLog, SystemLogCallback } from "../types";
import type { PromptUserFn } from "../../runtime/deploy-pipeline";
import { EdgeMigrateRequested, probeEdge } from "./detect";
import { canImportProxy, scanImportableSites } from "./import";
import { runEdgeTakeover, type EdgeTakeoverOptions, type EdgeTakeoverResult } from "./takeover";

// ── Engine surface (single import point) ──────────────────────────────────────
export {
  classifyProxy,
  EdgeConflictError,
  EdgeMigrateRequested,
  freeEdgeTargets,
  isOpenshipManagedEdge,
  probeEdge,
  stopTargetsForStatus,
} from "./detect";
export { runEdgeTakeover, recoverInterruptedTakeover } from "./takeover";
export { scanImportableSites, canImportProxy, scanOpenshipEdge } from "./import";
export type {
  EdgeClassification,
  EdgeConflictDetails,
  EdgeOccupant,
  EdgePolicy,
  EdgeStatus,
  EdgeStopTarget,
  ImportedSite,
  ProxyKind,
  ProxyScanResult,
} from "../types";

/** Detect who owns ports 80/443 (free | ours | known | unknown). Alias of the
 *  canonical probe so the module name reads at the call site. */
export const detectEdge = probeEdge;

/**
 * Scan the foreign proxy holding 80/443 into normalized sites — the ONE place
 * the "which occupant is the proxy → can we import its config → scan it" triad
 * lives. Previously copy-pasted verbatim in installer.ts (ensureEdgeClear),
 * self-edge.ts, and self-app.controller.ts. Returns an empty result (never
 * throws) when nothing importable is on the edge.
 */
export async function importSites(
  executor: CommandExecutor,
  status: EdgeStatus,
): Promise<ProxyScanResult> {
  const proxy = status.occupants.find((o) => o.proxy)?.proxy;
  if (!proxy) return { proxy: "nginx", sites: [], warnings: [] };
  // scanImportableSites now routes traefik (label-driven) to scanTraefik and
  // nginx/caddy/apache to their host-config parsers.
  if (canImportProxy(proxy)) return scanImportableSites(executor, proxy);
  return { proxy, sites: [], warnings: [`${proxy}: config import not supported — takeover only`] };
}

/**
 * Does a FOREIGN proxy currently own 80/443 — i.e. is the edge neither ours nor
 * free, so we must migrate / take over before we can bind it? The ONE home for
 * the "can we serve the edge, or must the operator resolve a foreign proxy first"
 * gate (was re-implemented as `foreignProxyBlocksEdge` in self-deploy.ts and
 * inline in self-edge.ts). `owner` is a human label of what's holding the ports.
 */
export async function foreignProxyOnEdge(
  executor: CommandExecutor,
): Promise<{ status: EdgeStatus; blocked: boolean; owner: string }> {
  const status = await probeEdge(executor);
  const blocked = !status.canProceedClean && status.occupants.length > 0;
  const owner = status.occupants.map((o) => o.command ?? `port ${o.port}`).join(", ");
  return { status, blocked, owner };
}

function sysLog(message: string, level: SystemLog["level"] = "info"): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}

/**
 * The user chose "migrate" at the edge-conflict hold: import the foreign proxy's
 * sites and take over 80/443, streaming warnings. The ONE home for the
 * `catch (EdgeMigrateRequested)` body that was copy-pasted into the deploy
 * pipeline and the server-setup installer (they only differ in what they do with
 * the result — throw vs. return an InstallResult — so this returns the raw
 * takeover result and lets the caller decide).
 */
/**
 * The SINGLE "ensure Openship owns the edge" orchestrator every caller should use
 * (deploy pipeline, server-setup, self-app, mail). You supply how to install the
 * edge feature for your target — `install(promptUser)` — which, if a foreign proxy
 * holds 80/443, raises the `edge_conflict` consent prompt through `promptUser`
 * (the SSE modal / CLI select), BLOCKS until the operator chooses, and either
 * takes over in place or throws `EdgeMigrateRequested`. This function then owns the
 * migrate outcome (import + `runEdgeTakeover` + rollback). Callers no longer
 * hand-write the try/install-catch-migrate/takeover skeleton — it lives here once.
 *
 * Generic over the install return so callers that need it (e.g. server-setup's
 * `InstallResult`) get it back via `{ migrated:false, value }`.
 */
export type EnsureEdgeOutcome<T> =
  | { migrated: false; value: T }
  | { migrated: true; ok: boolean; registered: string[] };

export async function ensureEdge<T>(
  executor: CommandExecutor,
  install: (promptUser?: PromptUserFn) => Promise<T>,
  opts: {
    promptUser?: PromptUserFn;
    onLog: SystemLogCallback;
    acmeEmail?: string;
    extraRoutes?: EdgeTakeoverOptions["extraRoutes"];
  },
): Promise<EnsureEdgeOutcome<T>> {
  try {
    return { migrated: false, value: await install(opts.promptUser) };
  } catch (err) {
    if (err instanceof EdgeMigrateRequested) {
      const takeover = await takeoverOnMigrate(executor, err, opts);
      return { migrated: true, ok: takeover.ok, registered: takeover.registered };
    }
    throw err;
  }
}

export async function takeoverOnMigrate(
  executor: CommandExecutor,
  migrate: EdgeMigrateRequested,
  opts: {
    onLog: SystemLogCallback;
    acmeEmail?: string;
    extraRoutes?: EdgeTakeoverOptions["extraRoutes"];
  },
): Promise<EdgeTakeoverResult> {
  opts.onLog(
    sysLog(
      `Migrating ${migrate.sites.length} site(s) from the existing proxy, then taking over 80/443…`,
      "warn",
    ),
  );
  const takeover = await runEdgeTakeover(
    executor,
    { status: migrate.status, sites: migrate.sites, acmeEmail: opts.acmeEmail, extraRoutes: opts.extraRoutes },
    opts.onLog,
  );
  for (const w of [...migrate.warnings, ...takeover.warnings]) opts.onLog(sysLog(w, "warn"));
  return takeover;
}
