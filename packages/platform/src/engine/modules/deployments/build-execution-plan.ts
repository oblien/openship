/**
 * Pure decision logic for HOW a single-app deploy builds and serves — extracted
 * from build-pipeline.ts so the pipeline reads as a sequence and the three
 * interleaved axes (target / runtime / static-vs-server) are decided as DATA,
 * not via a `snapshot.runtimeMode` mutate-then-undo + scattered `instanceof`.
 *
 * Two steps, matching the pipeline's ordering:
 *   1. resolveBuildRuntimeModes — BEFORE platform resolution: what runtimeMode to
 *      resolve the BUILD with, and what to PERSIST as the serve/lifecycle identity.
 *   2. resolveDeployRouting — AFTER resolution (needs the concrete runtime): how to
 *      route the build + deploy. Keyed off the resolved runtime's `.name`, exactly
 *      as the old inline `instanceof` checks were.
 */

import type { WorkloadType } from "@repo/core";

export type BuildMode = "static-sandbox" | "static-bare" | "normal";
/** `worker` = a portless long-running container: built normally, but served with
 *  no doc-root and no route (issue #538-B). */
export type DeployMode = "static-edge" | "static-file-serve" | "server" | "worker";
export type RuntimeModeValue = "bare" | "docker";

export interface BuildRuntimeModes {
  /** runtimeMode to RESOLVE the platform with for the build; `undefined` = use the
   *  snapshot's own runtimeMode unchanged. */
  buildRuntimeMode: RuntimeModeValue | undefined;
  /** runtimeMode to PERSIST as the deployment's serve/lifecycle identity;
   *  `undefined` = leave the snapshot's runtimeMode unchanged. */
  serveRuntimeMode: RuntimeModeValue | undefined;
}

export interface DeployRouting {
  buildMode: BuildMode;
  deployMode: DeployMode;
  /** outputDirectory to serve a static file-serve deploy from ("" when the doc-root
   *  was already extracted by a Docker sandbox build). */
  staticServeOutputDir: string;
}

/**
 * The runtime-mode decision, made BEFORE platform resolution. Encodes the two
 * historical "flips" as data:
 *   - services → Docker (containers can't run bare) for build AND serve.
 *   - a worker → Docker for build AND serve: a portless supervised container has
 *     no bare/static form (issue #538-B).
 *   - a static app on a server / self-hosted host → BUILD in a Docker sandbox, but
 *     its lifecycle identity stays BARE (files served by the edge; a persisted
 *     "docker" would make rollback/purge 404-no-op on the release dir and leak it).
 * Cloud static and Docker-less desktop-local static are left to their own runtime.
 */
export function resolveBuildRuntimeModes(input: {
  workload: WorkloadType;
  serverId: string | null | undefined;
  baseTarget: "desktop" | "selfhosted" | "cloud";
  effectiveTarget: "local" | "server" | "cloud";
  willRunServices: boolean;
  /** A single-app OCI image is already built, but still needs a container
   * runtime to pull and run it. Bare mode cannot consume that artifact. */
  hasPrebuiltImage?: boolean;
}): BuildRuntimeModes {
  if (input.hasPrebuiltImage && input.effectiveTarget !== "cloud") {
    return { buildRuntimeMode: "docker", serveRuntimeMode: "docker" };
  }
  if (input.willRunServices || input.workload === "worker") {
    return { buildRuntimeMode: "docker", serveRuntimeMode: "docker" };
  }
  if (
    input.workload === "static" &&
    input.effectiveTarget !== "cloud" &&
    (!!input.serverId || input.baseTarget === "selfhosted")
  ) {
    return { buildRuntimeMode: "docker", serveRuntimeMode: "bare" };
  }
  return { buildRuntimeMode: undefined, serveRuntimeMode: undefined };
}

/**
 * The build + deploy routing, made AFTER platform resolution — keyed off the
 * resolved runtime's `.name` (the ground truth), which is exactly what the old
 * inline `runtime instanceof …` checks did. Centralizing them here is the point:
 * one place decides static-sandbox vs static-bare vs normal, and static-edge
 * (cloud) vs static-file-serve vs server.
 */
export function resolveDeployRouting(input: {
  workload: WorkloadType;
  runtimeName: string; // "bare" | "docker" | "cloud"
  outputDirectory: string;
}): DeployRouting {
  if (input.workload === "web") {
    return { buildMode: "normal", deployMode: "server", staticServeOutputDir: "" };
  }
  // A worker builds its image normally but is served with no doc-root and no
  // route — it just runs as a supervised container (issue #538-B).
  if (input.workload === "worker") {
    return { buildMode: "normal", deployMode: "worker", staticServeOutputDir: "" };
  }
  // Static, cloud target → Oblien Pages (executeStaticEdgeDeploy); build via CloudRuntime.
  if (input.runtimeName === "cloud") {
    return { buildMode: "normal", deployMode: "static-edge", staticServeOutputDir: "" };
  }
  // Static, self-hosted → served as files by the edge. Docker-built → doc-root
  // already extracted (serve from release root ""); bare-built → serve from output dir.
  const dockerBuilt = input.runtimeName === "docker";
  return {
    buildMode: dockerBuilt ? "static-sandbox" : "static-bare",
    deployMode: "static-file-serve",
    staticServeOutputDir: dockerBuilt ? "" : input.outputDirectory,
  };
}

/**
 * Correct the routing for a deploy that REUSES an existing static release
 * directory instead of building one (a rollback restoring a pinned release —
 * see `reuseRetainedArtifact`).
 *
 * `resolveDeployRouting` answers `staticServeOutputDir` from the runtime that is
 * about to BUILD, which is the right answer for a build and the wrong one for a
 * release that already exists: where that release's doc-root sits was decided
 * when its files were extracted, and no later runtime resolution moves them.
 *
 * The two resolutions agree only while nothing about the box has changed, and
 * `dockerBuilt` is not derivable from the release either — a self-hosted static
 * builds in a Docker sandbox but persists `runtimeMode: "bare"` (its SERVE
 * identity), so the answer genuinely cannot be recomputed; it can only be read
 * back. Drift is ordinary: a desktop project with no `runtime_mode` resolves
 * bare while Docker isn't running and docker once it is, which flips the answer
 * for the same release. Both directions fail badly and neither says why — "" on
 * a bare-built release publishes the promoted SOURCE tree (and prunes `.git` out
 * of it) and reports SUCCESS, while `"dist"` on a sandbox-built release aborts
 * the promote with "check the build command and the Output Directory setting"
 * for a restore that ran no build at all.
 *
 * `frozen` is the release's own persisted `DeploymentMeta.staticServeOutputDir`.
 * Checked for PRESENCE, not truthiness — `""` IS the answer for a sandbox-built
 * release and is the one this most needs to preserve. Absent (a release older
 * than the field) keeps the derived answer: there is nothing better to use.
 */
export function reusedReleaseRouting(
  routing: DeployRouting,
  frozen: string | undefined,
): DeployRouting {
  if (routing.deployMode !== "static-file-serve" || frozen === undefined) return routing;
  return { ...routing, staticServeOutputDir: frozen };
}
