import {
  buildImage,
  imageExistsLocally,
  type CommandExecutor,
  type SystemLog,
} from "@repo/adapters";
import { posix } from "node:path";

import { edgeBuildSpec } from "./edge-image";
import { mailBuildSpec } from "./mail-image";

/**
 * Stage B of the managed-image pipeline: get OUR source built into the pinned image
 * ON THE BOX that will run it — the APPLY that the drift CHECK (the content-derived
 * dev tag in `pinned*Image()`) asks for.
 *
 * Build ON THE TARGET, never cross-build on the control plane. The control plane may
 * be an arm64 Mac while the target is an amd64 Linux box; emitting a foreign platform
 * needs buildx + QEMU/binfmt, which a plain `docker` CLI (homebrew + colima, no Docker
 * Desktop) doesn't have — that is exactly the "BuildKit … buildx component is missing"
 * failure this path replaces. Each box builds for its OWN arch with its OWN builder,
 * so there is nothing to cross-compile and no binfmt to install anywhere.
 *
 * Three shapes, one mechanism, keyed off what the target already has — never off a
 * serverId (a "This Machine" server row is a remote-shaped id over a LOCAL executor,
 * so only the filesystem can answer "is the checkout here"):
 *   1. The exact content tag is already on the box → its bytes ARE our current source
 *      (the tag moves on every edit), so there is nothing to build or ship.
 *   2. The checkout is readable on the target at its own path (self / "This Machine" /
 *      any local daemon) → build in place from it.
 *   3. Neither (a remote SSH box) → ship the git-truth source (tracked + not-ignored,
 *      node_modules/.git and build output excluded by default) to a temp dir, build
 *      there, then remove it.
 *
 * Prod collapses to today, byte-for-byte: no checkout → `*BuildSpec()` is undefined →
 * `{ delivered: false }` with no build and no transfer, and the adapters gate finds
 * the image absent and `docker pull`s the published tag.
 */
export interface DeliverManagedImageOpts {
  kind: "edge" | "mail";
  /** The resolved pinned ref — dev-suffixed in a checkout, plain APP_VERSION in prod. */
  image: string;
  /** The box the image is FOR — probed for the checkout, built on, shipped to. */
  targetExecutor: CommandExecutor;
  onLog: (log: SystemLog) => void;
}

export async function deliverManagedImage(
  opts: DeliverManagedImageOpts,
): Promise<{ delivered: boolean }> {
  const { kind, image, targetExecutor, onLog } = opts;
  const spec = kind === "edge" ? edgeBuildSpec() : mailBuildSpec();
  // No checkout to build from → prod / compiled install. The adapters gate pulls the
  // published tag; this returns without touching any daemon.
  if (!spec) return { delivered: false };

  // (1) The content-derived tag is already present → the box is already on this exact
  // source. Skipping here keeps a per-reconcile deliver from re-shipping + rebuilding
  // unchanged source on every deploy.
  if (await imageExistsLocally(targetExecutor, image).catch(() => false)) {
    return { delivered: true };
  }

  const emit = (message: string, level: SystemLog["level"] = "info") =>
    onLog({ timestamp: new Date().toISOString(), level, message });

  // (2) Is the checkout readable on the target itself? True for the self/local control
  // plane and a "This Machine" server row (same filesystem); false for a remote box.
  const dockerfileOnTarget = posix.join(spec.context, spec.dockerfile);
  if (await targetExecutor.exists(dockerfileOnTarget).catch(() => false)) {
    await buildImage(targetExecutor, image, spec, onLog, kind);
    return { delivered: true };
  }

  // (3) Remote box: ship the git-truth source, build NATIVELY there, clean up. The
  // build context comes from `spec` (server-derived), never a request — it feeds
  // `docker build`, which runs the Dockerfile's RUN steps as root.
  const remoteContext = `/tmp/openship-managed-build-${kind}-${image.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  try {
    emit(`Shipping the ${kind} build context to the server...`);
    await targetExecutor.transferIn(spec.context, remoteContext, (l) => emit(l.message));
    await buildImage(
      targetExecutor,
      image,
      { context: remoteContext, dockerfile: spec.dockerfile },
      onLog,
      kind,
    );
  } finally {
    await targetExecutor.rm(remoteContext).catch(() => {});
  }
  return { delivered: true };
}
