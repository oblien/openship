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
}

export function createBuildConfig(opts: {
  project: Project;
  dep: Deployment;
  snapshot: BuildConfigSnapshotLike;
  sessionId: string;
  envVars: Record<string, string>;
  resources: ResourceConfig;
  gitToken?: string;
  overrides?: Partial<BuildConfig>;
}): BuildConfig {
  const { project, dep, snapshot, sessionId, envVars, resources, gitToken, overrides } = opts;

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
    ...overrides,
  };
}
