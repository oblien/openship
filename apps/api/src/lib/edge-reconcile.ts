import {
  dockerAvailable,
  ensureContainerEdge,
  type CommandExecutor,
  type PromptUserFn,
  type SystemLog,
} from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";

import { pinnedEdgeImage } from "./edge-image";

/**
 * Converge a server's edge onto the container image.
 *
 * ── Why this is NOT inside `SystemManager.ensureFeature("routing")` ──
 *
 * Not a layering problem: `setDefaultEdgeImage` injects the pin into adapters at
 * boot, so `ensureContainerEdge` resolves the right image no matter who calls it.
 *
 * The reason is BLAST RADIUS. `ensureFeature` is the component-readiness check and
 * it runs from more than deploys — `ensureFeature("ssl")` fires from the domain-SSL
 * preflight and from `self-edge.ts` at API startup. Converging in there would let a
 * bare→container conversion, which stops the host OpenResty and restarts :80/:443
 * on a live box, be triggered by a cert preflight or by the API simply booting. The
 * agreed behaviour is "auto-migrate on the next DEPLOY", so the trigger stays at the
 * deploy site where the operator is already expecting movement.
 *
 * And it can't ride ON ensureFeature's result either: that returns early when no
 * component is missing, so it would skip a box whose edge is present but stale.
 * This runs regardless; `ensureContainerEdge` is idempotent (one memoized
 * `docker ps` when there's nothing to do).
 *
 * Best-effort by contract: routing/edge problems never fail a deploy (see
 * [[domains-never-fail-deploy]]), and `ensureContainerEdge` restores whatever was
 * serving before if its own steps fail. Returns what it did, for the deploy log.
 */
export async function reconcileServerEdge(
  executor: CommandExecutor,
  opts: {
    onLog: (log: SystemLog) => void;
    promptUser?: PromptUserFn;
  },
): Promise<{ converted: boolean; updated: boolean; edgeDown: boolean }> {
  // No Docker reachable on this target → nothing here can reconcile, and saying so
  // would be noise on the two topologies where it's expected: the compose stack's
  // own api container (no docker CLI in the image — it drives the daemon through
  // dockerode, and compose owns that edge anyway), and a genuinely Docker-less
  // server, where the install path already logs its fall back to the host edge.
  if (!(await dockerAvailable(executor).catch(() => false))) {
    return { converted: false, updated: false, edgeDown: false };
  }

  try {
    const image = pinnedEdgeImage();
    const result = await ensureContainerEdge(executor, {
      onLog: opts.onLog,
      image,
      config: { edgeImage: image, promptUser: opts.promptUser },
    });
    return {
      converted: result.converted,
      updated: Boolean(result.updated),
      edgeDown: Boolean(result.edgeDown),
    };
  } catch (err) {
    opts.onLog({
      timestamp: new Date().toISOString(),
      level: "warn",
      message:
        `Edge is still on its previous setup (${safeErrorMessage(err)}) — ` +
        `the deploy continues and routing is retried later.`,
    });
    // A throw means ensureContainerEdge restored whatever was serving before, so the
    // edge is not down — that's its contract on the failure path.
    return { converted: false, updated: false, edgeDown: false };
  }
}

/** The subset of SystemManager this needs — keeps the helper testable and avoids
 *  dragging the platform type through. */
interface RoutingFeatureManager {
  ensureFeature(
    feature: "routing",
    onLog?: (log: SystemLog) => void,
    config?: { promptUser?: PromptUserFn },
  ): Promise<void>;
}

/**
 * "Make this server able to serve routes" — components THEN edge convergence, in
 * that order, as one step.
 *
 * Both halves are required and neither implies the other: `ensureFeature` installs
 * what's missing (and no-ops when nothing is), `reconcileServerEdge` moves an
 * existing edge onto the container image (and no-ops when it's already there). They
 * were called as a pair in the single-app and compose deploy paths, which meant a
 * third deploy path could easily do the first and forget the second — and the
 * failure mode of forgetting is invisible: the box keeps serving on its old edge, so
 * nothing looks broken until the Lua and the API disagree.
 *
 * Order matters: components first, because the edge convergence needs Docker on the
 * box, and Docker is one of the components `ensureFeature` installs.
 */
export async function ensureRoutingReady(
  executor: CommandExecutor,
  system: RoutingFeatureManager,
  opts: { onLog: (log: SystemLog) => void; promptUser?: PromptUserFn },
): Promise<{ edgeDown: boolean }> {
  await system.ensureFeature("routing", opts.onLog, { promptUser: opts.promptUser });
  const { edgeDown } = await reconcileServerEdge(executor, opts);
  // The one outcome a caller must be able to act on: an image swap failed AND its
  // rollback failed, so nothing is serving 80/443 — every domain on the box is down,
  // not just this deploy's. Reported rather than logged, because "no edge" and
  // "already up to date" were previously the same return value.
  if (edgeDown) {
    opts.onLog({
      timestamp: new Date().toISOString(),
      level: "error",
      message:
        "The edge is DOWN on this server — an image update failed and the rollback " +
        "failed too. Every domain served by this box is affected until it is restored.",
    });
  }
  return { edgeDown };
}
