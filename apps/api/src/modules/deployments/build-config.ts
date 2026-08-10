import type { BuildConfig, ResourceConfig } from "@repo/adapters";
import type { Deployment, Project } from "@repo/db";
import type { BuildStrategy } from "@repo/core";

export interface BuildConfigSnapshotLike {
  repoUrl: string;
  branch: string;
  framework: string;
  buildImage: string;
  runtimeImage: string;
  packageManager: string;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  productionPaths: string[];
  rootDirectory: string;
  port: number;
  startCommand: string;
  hasServer: boolean;
  hasBuild: boolean;
  localPath?: string;
  buildStrategy?: BuildStrategy;
  /** ONE-TIME image handover (migration cutover): serviceName → an already-present
   *  image ref (a transferred / running container's image). A service listed here
   *  is deployed from that image with NO build and NO pull — the build step seeds
   *  it straight into `imageRefs`. Only set on the migration's first deploy (the
   *  snapshot is per-deployment), so a later Redeploy has no handover and rebuilds/
   *  pulls natively. This is how migration hands its images to the native pipeline
   *  instead of forking a second deploy path. */
  handoverImages?: Record<string, string>;
}

export interface BuildConfigFactoryOptions {
  project: Project;
  dep: Deployment;
  snapshot: BuildConfigSnapshotLike;
  sessionId: string;
  envVars: Record<string, string>;
  resources: ResourceConfig;
  gitToken?: string;
  /** Desktop-only: remote credential-helper script path (deploy relay fallback). */
  gitCredentialHelperPath?: string;
  overrides?: Partial<BuildConfig>;
}

export function createBuildConfig(opts: BuildConfigFactoryOptions): BuildConfig {
  const { project, dep, snapshot, sessionId, envVars, resources, gitToken, gitCredentialHelperPath, overrides } = opts;

  return {
    sessionId,
    projectId: project.id,
    slug: project.slug ?? undefined,
    repoUrl: snapshot.repoUrl,
    branch: dep.branch,
    commitSha: dep.commitSha ?? undefined,
    localPath: snapshot.localPath,
    buildStrategy: snapshot.buildStrategy,
    stack: snapshot.framework,
    buildImage: snapshot.buildImage,
    runtimeImage: snapshot.runtimeImage,
    packageManager: snapshot.packageManager,
    installCommand: snapshot.hasBuild ? snapshot.installCommand : "",
    workspacePrepareCommand: project.workspacePrepareCommand?.trim() || undefined,
    buildCommand: snapshot.hasBuild ? snapshot.buildCommand : "",
    outputDirectory: snapshot.outputDirectory,
    port: snapshot.port,
    startCommand: snapshot.startCommand,
    productionPaths: snapshot.productionPaths,
    rootDirectory: snapshot.rootDirectory,
    hasServer: snapshot.hasServer,
    envVars,
    resources,
    gitToken,
    gitCredentialHelperPath,
    ...overrides,
  };
}

export function createDockerfileBuildConfig(
  opts: BuildConfigFactoryOptions,
): BuildConfig {
  return createBuildConfig({
    ...opts,
    overrides: {
      ...opts.overrides,
      stack: "docker",
      buildStrategy: "server",
      installCommand: "",
      buildCommand: "",
      outputDirectory: "",
      startCommand: "",
      productionPaths: [],
    },
  });
}

/**
 * Build config for a monorepo sub-app built from source (no Dockerfile in the
 * repo). The runtime's generated-Dockerfile branch fires when:
 *   1. stack !== "docker"   (we pass the sub-app's framework instead)
 *   2. No Dockerfile exists at the resolved root directory
 *
 * Under those conditions the runtime synthesizes a Dockerfile from
 * installCommand + buildCommand + startCommand + outputDirectory +
 * productionPaths, identical to how the single-app source pipeline builds.
 *
 * Unlike `createDockerfileBuildConfig`, this factory PRESERVES install/build/
 * start/output fields from `overrides` (or the snapshot) - those are exactly
 * what the runtime consumes to generate the Dockerfile.
 */
export function createMonorepoSourceBuildConfig(
  opts: BuildConfigFactoryOptions,
): BuildConfig {
  return createBuildConfig({
    ...opts,
    overrides: {
      buildStrategy: "server",
      hasServer: true,
      ...opts.overrides,
      // EXPLICIT undefined. The runtime's generated-Dockerfile branch fires
      // only when dockerfilePath is null/undefined AND the resolved root
      // has no Dockerfile file. If a caller ever spreads in an override
      // block that accidentally sets dockerfilePath, the synthesized-
      // Dockerfile path would silently disappear and we'd fall to "no
      // Dockerfile found" errors. Pinning it last guarantees the contract.
      dockerfilePath: undefined,
    },
  });
}
