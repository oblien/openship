import {
  dockerAvailable,
  ensureContainerEdge,
  waitForPortListening,
  type CommandExecutor,
  type PromptUserFn,
  type SystemLog,
} from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";

import { deliverManagedImage } from "./deliver-managed-image";
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
 * serving before if its own steps fail. Never throws — it REPORTS instead, and
 * `error` is the difference between "nothing to do" and "it did not work".
 */
export interface EdgeReconcileResult {
  /** This call moved a foreign/legacy proxy onto the container edge. */
  converted: boolean;
  /** This call replaced a running edge with a different image. */
  updated: boolean;
  /**
   * NOTHING is serving :80 on this box — every domain on it is dark. Deliberately
   * a claim about the SERVER, not about this call, so it is measured rather than
   * inferred (see the catch).
   */
  edgeDown: boolean;
  /**
   * Why this call did not leave our container edge serving — the consent refusal
   * (`EdgeConflictError`), a port that never came free (`EDGE_PORTS_STILL_BOUND`),
   * a failed pull, an `[emerg]` from the container.
   *
   * It exists because the three all-false fields are also what a perfectly healthy,
   * already-current edge returns: without this, `applyServerContainer` reported a
   * refused install as "nothing needed doing", the apply session finished
   * `completed`, and the operator got a green banner over a box whose edge had never
   * bound :80. A caller that only cares whether the box is dark still reads
   * `edgeDown`; a caller reporting an ACTION's outcome must read this.
   */
  error?: string;
}

export async function reconcileServerEdge(
  executor: CommandExecutor,
  opts: {
    onLog: (log: SystemLog) => void;
    promptUser?: PromptUserFn;
  },
): Promise<EdgeReconcileResult> {
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
    // Stage-B APPLY: build our source onto this box (or ship + build for a remote one)
    // so the create/swap below adopts the dev image instead of pulling an unpublished
    // tag. No-op in prod (no checkout → deliver returns immediately).
    await deliverManagedImage({ kind: "edge", image, targetExecutor: executor, onLog: opts.onLog });
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
    const error = safeErrorMessage(err);
    // `ensureContainerEdge` restores whatever it stopped — but a restore can itself
    // fail, so "a throw means something is still serving" was an assumption, not a
    // fact. Measure it: one socket-table read, and `checked:false` (unusable
    // executor) is NO SIGNAL — never proof the box is dark.
    const probe = await waitForPortListening(executor, 80, { timeoutMs: 0 }).catch(() => ({
      listening: false,
      checked: false,
    }));
    const serving = probe.checked ? probe.listening : true;
    opts.onLog({
      timestamp: new Date().toISOString(),
      level: serving ? "warn" : "error",
      message: serving
        ? `The edge did not converge (${error}) — the server is still served by whatever ` +
          `held 80/443 before, and this is retried on the next deploy.`
        : `The edge did not converge (${error}) — and nothing is listening on :80 on ` +
          `this server, so every domain it serves is down.`,
    });
    return { converted: false, updated: false, edgeDown: !serving, error };
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
  opts: {
    onLog: (log: SystemLog) => void;
    promptUser?: PromptUserFn;
  },
): Promise<{ edgeDown: boolean }> {
  await system.ensureFeature("routing", opts.onLog, { promptUser: opts.promptUser });
  const { edgeDown, error } = await reconcileServerEdge(executor, opts);
  // The one outcome a caller must be able to act on: an image swap failed AND its
  // rollback failed, so nothing is serving 80/443 — every domain on the box is down,
  // not just this deploy's. Reported rather than logged, because "no edge" and
  // "already up to date" were previously the same return value.
  //
  // Only for the swap route to a dark box: when the reconcile CAUGHT the failure it
  // already logged the cause (and this sentence's "an image update failed" would be
  // a guess about a refused takeover or a failed pull).
  if (edgeDown && !error) {
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
