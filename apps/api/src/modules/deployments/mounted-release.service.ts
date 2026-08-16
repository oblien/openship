import { assembleGitClone } from "@repo/adapters";
import { shellQuote, safeErrorMessage, AppError } from "@repo/core";
import { repos, type Deployment, type Project } from "@repo/db";
import type { RequestContext } from "../../lib/request-context";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { resolveServerExecutor } from "../../lib/deployment-runtime";
import { livePrimaryContainerId } from "../services/service-container";
import { resolveBuildGitToken } from "../github/clone-auth";
import { assertGitHubRepoAccess } from "../github/github-access";
import { createQueuedDeployment, buildConfigSnapshot, checkNoActiveBuild } from "./build.service";
import * as sessionManager from "./session-manager";
import {
  mountedReleaseBuildMode,
  mountedReleaseConfig,
  mountedReleaseHostRoot,
  type MountedReleaseConfig,
} from "./mounted-release.config";

const RELEASE_ERROR = "MOUNTED_RELEASE_FAILED";

function log(deploymentId: string, message: string, level: "info" | "warn" | "error" = "info") {
  sessionManager.appendLog(deploymentId, {
    timestamp: new Date().toISOString(),
    message,
    level,
  });
}

function validateRef(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..")) {
    throw new AppError(`Invalid ${label}.`, 400, RELEASE_ERROR);
  }
  return value;
}

function releaseMeta(dep: Pick<Deployment, "meta">): {
  deploymentLane?: string;
  releaseRoot?: string;
} {
  const meta = (dep.meta ?? {}) as { deploymentLane?: string; mountedReleaseRoot?: string };
  return { deploymentLane: meta.deploymentLane, releaseRoot: meta.mountedReleaseRoot };
}

async function activeRuntime(
  project: Project,
): Promise<{ deployment: Deployment; containerId: string }> {
  if (!project.activeDeploymentId) {
    throw new AppError(
      "Build the runtime once before deploying code so OpenShip can attach the release mount.",
      409,
      "MOUNTED_RELEASE_RUNTIME_REQUIRED",
    );
  }
  const deployment = await repos.deployment.findById(project.activeDeploymentId);
  if (!deployment)
    throw new AppError("The active runtime deployment is missing.", 409, RELEASE_ERROR);
  const containerId = await livePrimaryContainerId(null, deployment);
  if (!containerId) {
    throw new AppError("The active runtime container could not be resolved.", 409, RELEASE_ERROR);
  }
  return { deployment, containerId };
}

function dockerExec(containerId: string, workdir: string | null, command: string): string {
  const cwd = workdir ? ` -w ${shellQuote(workdir)}` : "";
  return `docker exec${cwd} ${shellQuote(containerId)} sh -lc ${shellQuote(command)}`;
}

function builderRun(
  hostRoot: string,
  releaseDir: string,
  deploymentId: string,
  config: MountedReleaseConfig,
): string {
  const image = config.builderImage?.trim();
  if (!image || !config.prepareCommand?.trim()) {
    throw new AppError("A builder image and prepare command are required.", 400, RELEASE_ERROR);
  }
  const name = `openship-release-${deploymentId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
  const memory = config.builderMemoryMb ?? 1024;
  const cpus = config.builderCpus ?? 1;
  const cacheVolumes = (config.builderCachePaths ?? [])
    .map((path) => {
      const relative = path.replace(/^\/+|\/+$/g, "");
      return `-v ${shellQuote(`${hostRoot}/builder-cache/paths/${relative}:/workspace/${relative}`)} `;
    })
    .join("");
  return (
    `docker run --rm --name ${shellQuote(name)} ` +
    `--memory ${shellQuote(`${memory}m`)} --cpus ${shellQuote(String(cpus))} ` +
    `-v ${shellQuote(`${releaseDir}:/workspace`)} -w /workspace ` +
    `-v ${shellQuote(`${hostRoot}/builder-cache:/cache`)} ` +
    cacheVolumes +
    `${shellQuote(image)} sh -lc ${shellQuote(config.prepareCommand)}`
  );
}

async function prepareBuilderCachePaths(
  executor: Awaited<ReturnType<typeof resolveServerExecutor>>["executor"],
  hostRoot: string,
  paths: string[],
): Promise<void> {
  const directories = paths
    .map((path) => path.replace(/^\/+|\/+$/g, ""))
    .filter((path) => path && !path.split("/").includes(".."))
    .map((path) => `${hostRoot}/builder-cache/paths/${path}`);
  if (directories.length > 0) {
    await executor.exec(`mkdir -p ${directories.map(shellQuote).join(" ")}`);
  }
}

async function runReload(
  executor: Awaited<ReturnType<typeof resolveServerExecutor>>["executor"],
  containerId: string,
  config: MountedReleaseConfig,
): Promise<void> {
  if (config.reloadCommand?.trim()) {
    await executor.exec(
      dockerExec(containerId, `${config.containerPath}/current`, config.reloadCommand),
    );
  } else {
    await executor.exec(`docker restart ${shellQuote(containerId)} >/dev/null`);
  }
}

async function checkHealth(
  executor: Awaited<ReturnType<typeof resolveServerExecutor>>["executor"],
  containerId: string,
  config: MountedReleaseConfig,
  fallbackPort: number,
): Promise<void> {
  const path = config.healthPath?.trim();
  if (!path) return;
  const port = config.healthPort ?? fallbackPort;
  const url = `http://127.0.0.1:${port}${path}`;
  const probe =
    `for i in 1 2 3 4 5 6 7 8 9 10; do ` +
    `(command -v curl >/dev/null && curl -fsS --max-time 3 ${shellQuote(url)} >/dev/null) || ` +
    `(command -v wget >/dev/null && wget -q -T 3 -O /dev/null ${shellQuote(url)}) && exit 0; ` +
    `sleep 1; done; exit 1`;
  await executor.exec(dockerExec(containerId, null, probe), { timeout: 30_000 });
}

async function prepareSharedPaths(
  executor: Awaited<ReturnType<typeof resolveServerExecutor>>["executor"],
  hostRoot: string,
  releaseDir: string,
  paths: string[],
): Promise<void> {
  for (const raw of paths) {
    const [pathValue, existingContainerTarget] = raw.split("=", 2);
    const path = pathValue!.replace(/^\/+|\/+$/g, "");
    if (!path || path.split("/").includes("..")) continue;
    const target = `${releaseDir}/${path}`;
    const parent = target.substring(0, target.lastIndexOf("/"));
    if (existingContainerTarget?.startsWith("/")) {
      await executor.exec(
        `mkdir -p ${shellQuote(parent)}; rm -rf ${shellQuote(target)}; ` +
          `ln -s ${shellQuote(existingContainerTarget)} ${shellQuote(target)}`,
      );
      continue;
    }
    const shared = `${hostRoot}/shared/${path}`;
    const script =
      `mkdir -p ${shellQuote(shared)} ${shellQuote(parent)}; ` +
      `rm -rf ${shellQuote(target)}; ` +
      `relative=$(realpath --relative-to=${shellQuote(parent)} ${shellQuote(shared)}); ` +
      `ln -s "$relative" ${shellQuote(target)}`;
    await executor.exec(script);
  }
}

async function finish(
  dep: Deployment,
  status: "ready" | "failed",
  startedAt: number,
  error?: unknown,
) {
  const session = sessionManager.getSession(dep.id);
  const duration = Date.now() - startedAt;
  const errorMessage = error ? safeErrorMessage(error).slice(0, 2000) : undefined;
  await repos.deployment.updateStatus(dep.id, status, {
    buildDurationMs: duration,
    ...(errorMessage ? { errorMessage, errorCode: RELEASE_ERROR } : {}),
  });
  const buildSession = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
  if (buildSession) {
    await repos.deployment.finishBuildSession(
      buildSession.id,
      status,
      duration,
      session?.logs ?? [],
    );
  }
  sessionManager.updateStatus(dep.id, status, {
    ...(errorMessage ? { errorMessage, errorCode: RELEASE_ERROR } : {}),
  });
}

async function runMountedRelease(
  ctx: RequestContext,
  project: Project,
  dep: Deployment,
  requestedCommit?: string,
): Promise<void> {
  const startedAt = Date.now();
  const config = mountedReleaseConfig(project)!;
  const hostRoot = mountedReleaseHostRoot(project.id);
  const incoming = `${hostRoot}/.incoming-${dep.id}`;
  const releaseDir = `${hostRoot}/releases/${dep.id}`;
  const authDir = `${hostRoot}/.auth-${dep.id}`;
  let previous = "";
  let activated = false;
  let token: string | undefined;

  try {
    await repos.deployment.updateStatus(dep.id, "building");
    sessionManager.updateStatus(dep.id, "building");
    log(dep.id, "Preparing mounted code release");

    const runtime = await activeRuntime(project);
    const serverId =
      project.serverId ?? (runtime.deployment.meta as { serverId?: string } | null)?.serverId;
    const { executor } = await resolveServerExecutor(serverId ?? undefined, project.organizationId);
    const repoUrl = project.gitUrl;
    if (!repoUrl)
      throw new AppError("Mounted releases require a linked Git repository.", 409, RELEASE_ERROR);
    const branch = validateRef(project.gitBranch || "main", "Git branch");
    const commit = requestedCommit ? validateRef(requestedCommit, "commit SHA") : null;

    const credential = await resolveBuildGitToken({
      ctx,
      projectId: project.id,
      owner: project.gitOwner,
      repo: project.gitRepo,
      buildStrategy: "server",
      serverId,
      serverExecutor: executor,
      repoUrl,
      onLog: (message) => log(dep.id, message),
    });
    if (credential.relay || credential.apiHostFallback) {
      throw new AppError(
        "This release needs Git credentials available on the target server or a project/server deploy token.",
        409,
        "MOUNTED_RELEASE_REMOTE_GIT_REQUIRED",
      );
    }
    token = credential.token;
    if (credential.ssh) {
      await executor.mkdir(authDir);
      await executor.writeFile(`${authDir}/id`, credential.ssh.privateKey);
      await executor.writeFile(`${authDir}/known_hosts`, credential.ssh.knownHosts);
      await executor.exec(
        `chmod 700 ${shellQuote(authDir)} && chmod 600 ${shellQuote(`${authDir}/id`)} ${shellQuote(`${authDir}/known_hosts`)}`,
      );
    }
    const clone = assembleGitClone({
      repoUrl,
      gitToken: credential.token,
      ambient: credential.ambient,
      ssh: credential.ssh
        ? { keyFile: `${authDir}/id`, knownHostsFile: `${authDir}/known_hosts` }
        : undefined,
    });

    await executor.exec(
      `mkdir -p ${shellQuote(`${hostRoot}/releases`)} ${shellQuote(`${hostRoot}/shared`)} ${shellQuote(`${hostRoot}/builder-cache`)}; ` +
        `rm -rf ${shellQuote(incoming)} ${shellQuote(releaseDir)}; ` +
        `git init --bare ${shellQuote(`${hostRoot}/source.git`)} >/dev/null 2>&1 || true`,
    );
    const refspec = commit
      ? `+${commit}:refs/openship/${dep.id}`
      : `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
    await executor.exec(
      `${clone.gitEnv} git ${clone.credFlag} --git-dir=${shellQuote(`${hostRoot}/source.git`)} ` +
        `fetch --force --prune --depth 50 ${shellQuote(clone.cloneUrl)} ${shellQuote(refspec)}`,
      { timeout: 120_000 },
    );
    const resolvedSha = (
      await executor.exec(
        `git --git-dir=${shellQuote(`${hostRoot}/source.git`)} rev-parse ${shellQuote(commit ? `refs/openship/${dep.id}` : `refs/remotes/origin/${branch}`)}`,
      )
    ).trim();
    const tree = config.sourcePath?.replace(/^\/+|\/+$/g, "");
    await executor.exec(
      `mkdir -p ${shellQuote(incoming)}; ` +
        `git --git-dir=${shellQuote(`${hostRoot}/source.git`)} archive ${shellQuote(tree ? `${resolvedSha}:${tree}` : resolvedSha)} ` +
        `| tar -x -C ${shellQuote(incoming)}; mv ${shellQuote(incoming)} ${shellQuote(releaseDir)}`,
      { timeout: 120_000 },
    );
    await prepareSharedPaths(executor, hostRoot, releaseDir, config.sharedPaths ?? []);

    const containerRelease = `${config.containerPath}/releases/${dep.id}`;
    await executor
      .exec(dockerExec(runtime.containerId, null, `test -d ${shellQuote(containerRelease)}`))
      .catch(() => {
        throw new AppError(
          "The runtime does not have the mounted release root yet. Rebuild runtime once, then deploy code.",
          409,
          "MOUNTED_RELEASE_MOUNT_REQUIRED",
        );
      });

    if (mountedReleaseBuildMode(config) === "server" && config.prepareCommand?.trim()) {
      if (config.builderImage?.trim()) {
        log(dep.id, `Building release with ${config.builderImage}`);
        await prepareBuilderCachePaths(executor, hostRoot, config.builderCachePaths ?? []);
        await executor.exec(builderRun(hostRoot, releaseDir, dep.id, config), { timeout: 900_000 });
      } else {
        log(dep.id, "Preparing release in the app container");
        await executor.exec(
          dockerExec(runtime.containerId, containerRelease, config.prepareCommand),
          { timeout: 300_000 },
        );
      }
    } else {
      log(dep.id, "Using deployable files committed to Git");
    }

    await repos.deployment.updateStatus(dep.id, "deploying");
    sessionManager.updateStatus(dep.id, "deploying");
    previous = (
      await executor.exec(`readlink ${shellQuote(`${hostRoot}/current`)} 2>/dev/null || true`)
    ).trim();
    await executor.exec(
      `ln -sfn ${shellQuote(`releases/${dep.id}`)} ${shellQuote(`${hostRoot}/current.next`)} && ` +
        `mv -Tf ${shellQuote(`${hostRoot}/current.next`)} ${shellQuote(`${hostRoot}/current`)}`,
    );
    activated = true;
    log(dep.id, "Activated release; reloading the application");
    await runReload(executor, runtime.containerId, config);
    await checkHealth(executor, runtime.containerId, config, project.port ?? 3000);

    const version =
      (await repos.deployment.findReadyVersionByCommit(project.id, resolvedSha)) ??
      (await repos.deployment.getNextReadyVersion(project.id));
    await repos.deployment.updateStatus(dep.id, "ready", {
      commitSha: resolvedSha,
      version,
      imageRef: releaseDir,
      meta: {
        ...(dep.meta as Record<string, unknown>),
        deploymentLane: "release",
        mountedReleaseRoot: releaseDir,
        runtimeDeploymentId: runtime.deployment.id,
        runtimeContainerId: runtime.containerId,
      },
    });
    await repos.project.setActiveReleaseDeployment(project.id, dep.id);
    log(dep.id, `Code release ${resolvedSha.slice(0, 7)} is live`);
    await finish(dep, "ready", startedAt);

    const keep = config.retain ?? 5;
    const old = (await repos.deployment.listReadyOrderedDesc(project.id))
      .filter((item) => releaseMeta(item).deploymentLane === "release" && item.id !== dep.id)
      .slice(Math.max(0, keep - 1));
    for (const item of old) {
      const root = releaseMeta(item).releaseRoot;
      if (root && !item.pinned) await executor.rm(root).catch(() => {});
    }
    await executor.rm(authDir).catch(() => {});
  } catch (error) {
    const runtime = await activeRuntime(project).catch(() => null);
    const serverId =
      project.serverId ?? (runtime?.deployment.meta as { serverId?: string } | null)?.serverId;
    const resolved = await resolveServerExecutor(
      serverId ?? undefined,
      project.organizationId,
    ).catch(() => null);
    if (activated && resolved && runtime) {
      if (previous) {
        await resolved.executor
          .exec(
            `ln -sfn ${shellQuote(previous)} ${shellQuote(`${hostRoot}/current.next`)} && ` +
              `mv -Tf ${shellQuote(`${hostRoot}/current.next`)} ${shellQuote(`${hostRoot}/current`)}`,
          )
          .catch(() => {});
        await runReload(resolved.executor, runtime.containerId, config).catch(() => {});
      } else {
        await resolved.executor.rm(`${hostRoot}/current`).catch(() => {});
      }
    }
    await resolved?.executor.rm(authDir).catch(() => {});
    const message = safeErrorMessage(error).replaceAll(token ?? "\u0000", "[credential]");
    log(dep.id, message, "error");
    await finish(dep, "failed", startedAt, new Error(message));
  }
}

export async function triggerMountedRelease(
  ctx: RequestContext,
  projectId: string,
  opts?: { commitSha?: string },
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (!mountedReleaseConfig(project)) {
    throw new AppError("Mounted releases are not enabled for this project.", 409, RELEASE_ERROR);
  }
  await assertGitHubRepoAccess(ctx, { owner: project.gitOwner, repo: project.gitRepo });
  await checkNoActiveBuild(project.id);
  const runtime = await activeRuntime(project);
  const meta = {
    ...buildConfigSnapshot(project),
    deploymentLane: "release" as const,
    mountedReleaseRoot: mountedReleaseHostRoot(project.id),
    runtimeDeploymentId: runtime.deployment.id,
  };
  const dep = await createQueuedDeployment({
    projectId: project.id,
    organizationId: project.organizationId,
    branch: project.gitBranch || "main",
    environment: "production",
    framework: project.framework || "unknown",
    meta,
    envVars: null,
    commitSha: opts?.commitSha,
    trigger: opts?.commitSha ? "release-rollback" : "code-release",
    rollbackStrategy: "snapshot",
  });
  sessionManager.createSession(dep.id, project.id);
  void runMountedRelease(ctx, project, dep, opts?.commitSha);
  return dep;
}

export async function restoreMountedRelease(
  ctx: RequestContext,
  target: Deployment,
): Promise<Deployment> {
  if (releaseMeta(target).deploymentLane !== "release" || !target.commitSha) {
    throw new AppError("This is not a mounted code release.", 409, RELEASE_ERROR);
  }
  return triggerMountedRelease(ctx, target.projectId, { commitSha: target.commitSha });
}

export function isMountedRelease(dep: Pick<Deployment, "meta">): boolean {
  return releaseMeta(dep).deploymentLane === "release";
}
