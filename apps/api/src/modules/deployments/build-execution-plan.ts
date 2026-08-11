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

export type BuildMode = "static-sandbox" | "static-bare" | "normal";
export type DeployMode = "static-edge" | "static-file-serve" | "server";
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
 *   - a static app on a server / self-hosted host → BUILD in a Docker sandbox, but
 *     its lifecycle identity stays BARE (files served by the edge; a persisted
 *     "docker" would make rollback/purge 404-no-op on the release dir and leak it).
 * Cloud static and Docker-less desktop-local static are left to their own runtime.
 */
export function resolveBuildRuntimeModes(input: {
  hasServer: boolean;
  serverId: string | null | undefined;
  baseTarget: "desktop" | "selfhosted" | "cloud";
  effectiveTarget: "local" | "server" | "cloud";
  willRunServices: boolean;
}): BuildRuntimeModes {
  if (input.willRunServices) {
    return { buildRuntimeMode: "docker", serveRuntimeMode: "docker" };
  }
  if (
    !input.hasServer &&
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
  hasServer: boolean;
  runtimeName: string; // "bare" | "docker" | "cloud"
  outputDirectory: string;
}): DeployRouting {
  if (input.hasServer) {
    return { buildMode: "normal", deployMode: "server", staticServeOutputDir: "" };
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
