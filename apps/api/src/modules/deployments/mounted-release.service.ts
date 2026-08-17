import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assembleGitClone,
  materializeGitTokenAuth,
  shellGitSshWriter,
  type CommandExecutor,
} from "@repo/adapters";
import { shellQuote, safeErrorMessage, AppError, compareCommitSha } from "@repo/core";
import { repos, type Deployment, type Project } from "@repo/db";
import type { RequestContext } from "../../lib/request-context";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { resolveServerExecutor } from "../../lib/deployment-runtime";
import { liveContainerIdForService, livePrimaryContainerId } from "../services/service-container";
import { resolveBuildGitToken } from "../github/clone-auth";
import { assertGitHubRepoAccess } from "../github/github-access";
import {
  createQueuedDeployment,
  buildConfigSnapshot,
  checkNoActiveBuild,
  canonicalizeCommitRef,
} from "./build.service";
import * as sessionManager from "./session-manager";
import {
  abortMountedReleaseHostWork,
  assertReleaseNotCancelled,
  beginDeployRun,
  cancelledError,
  claimDeployLease,
  endDeployRun,
  execAndConfirm,
  execUnlessCancelled,
  isCancelledError,
  releaseDeployLease,
  revertIfIncompleteActivation,
  revertReleaseCurrent,
  type ReleasePhase,
} from "./deploy-lease";
import {
  mountedReleaseBuildMode,
  mountedReleaseConfig,
  mountedReleaseHealthPort,
  mountedReleaseHostRoot,
  resolveMountedReleaseRuntimeTarget,
  type MountedReleaseConfig,
} from "./mounted-release.config";
import { removeHostPath, sweepMountedReleaseHost } from "./mounted-release.cleanup";
import {
  freezeMountedReleaseContract,
  isMountedReleaseRow,
  markReleaseTreeReadOnlyCommand,
  mountedReleaseTreeRef,
  readMountedReleaseSnapshot,
  releaseBuilderName,
  releaseDirFor,
  stagedReleaseCleanupPaths,
  withSnapshotArtifact,
  withSnapshotCommit,
} from "./release-artifact";
import { prepareRelease } from "./release-driver";
import {
  publicHttpsProbeCommand,
  resolveProjectPublicHostname,
  type PublicHttpsResult,
} from "./public-https-health";
import type { ReleasePlan } from "./release-planner";

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
  releasePreviousCurrent?: string;
} {
  const meta = (dep.meta ?? {}) as {
    deploymentLane?: string;
    mountedReleaseRoot?: string;
    releasePreviousCurrent?: string;
  };
  return {
    deploymentLane: meta.deploymentLane,
    releaseRoot: meta.mountedReleaseRoot,
    releasePreviousCurrent: meta.releasePreviousCurrent,
  };
}

export async function findActiveSameShaRelease(
  project: Pick<Project, "activeReleaseDeploymentId">,
  commitSha: string,
): Promise<Deployment | null> {
  if (!project.activeReleaseDeploymentId) return null;
  const active = await repos.deployment.findById(project.activeReleaseDeploymentId);
  if (!active || active.status !== "ready") return null;
  if (compareCommitSha(active.commitSha, commitSha) !== "same") return null;
  return active;
}

async function activeRuntime(
  project: Project,
): Promise<{ deployment: Deployment; containerId: string; healthPort: number }> {
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
  const config = mountedReleaseConfig(project);
  const services = await repos.service.listByProject(project.id);
  const target = resolveMountedReleaseRuntimeTarget(config ?? {}, services);
  if (!target.ok) {
    throw new AppError(
      target.reason === "disabled"
        ? "The mounted release service is disabled. Enable it or choose another service."
        : "Choose an enabled compose service before deploying a mounted release.",
      409,
      "MOUNTED_RELEASE_SERVICE_REQUIRED",
    );
  }
  let containerId: string | null;
  if (target.mode === "service") {
    const serviceId = target.service.id;
    if (!serviceId) {
      throw new AppError(
        "Choose an enabled compose service before deploying a mounted release.",
        409,
        "MOUNTED_RELEASE_SERVICE_REQUIRED",
      );
    }
    containerId = await liveContainerIdForService(
      project,
      deployment,
      { id: serviceId, name: target.service.name },
      { projectId: project.id },
    );
  } else {
    containerId = await livePrimaryContainerId(null, deployment);
  }
  if (!containerId) {
    throw new AppError("The active runtime container could not be resolved.", 409, RELEASE_ERROR);
  }
  return {
    deployment,
    containerId,
    healthPort: mountedReleaseHealthPort(target, project.port ?? 3000),
  };
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

type HostExec = (command: string, opts?: { timeout?: number }) => Promise<string>;

async function prepareBuilderCachePaths(
  exec: HostExec,
  hostRoot: string,
  paths: string[],
): Promise<void> {
  const directories = paths
    .map((path) => path.replace(/^\/+|\/+$/g, ""))
    .filter((path) => path && !path.split("/").includes(".."))
    .map((path) => `${hostRoot}/builder-cache/paths/${path}`);
  if (directories.length > 0) {
    await exec(`mkdir -p ${directories.map(shellQuote).join(" ")}`);
  }
}

async function runReload(
  exec: HostExec,
  containerId: string,
  config: MountedReleaseConfig,
): Promise<void> {
  if (config.reloadCommand?.trim()) {
    await exec(dockerExec(containerId, `${config.containerPath}/current`, config.reloadCommand));
  } else {
    await exec(`docker restart ${shellQuote(containerId)} >/dev/null`);
  }
}

async function checkHealth(
  exec: HostExec,
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
  await exec(dockerExec(containerId, null, probe), { timeout: 30_000 });
}

async function checkPublicHttps(
  exec: HostExec,
  projectId: string,
  config: MountedReleaseConfig,
): Promise<PublicHttpsResult> {
  const hostname = await resolveProjectPublicHostname(projectId);
  if (!hostname) return { hostname: null, https: "skipped" };
  try {
    await exec(publicHttpsProbeCommand(hostname, config.healthPath?.trim() || "/"), {
      timeout: 20_000,
    });
    return { hostname, https: "passed" };
  } catch {
    return { hostname, https: "failed" };
  }
}

async function prepareSharedPaths(
  exec: HostExec,
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
      await exec(
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
    await exec(script);
  }
}

async function persistReleaseLogs(depId: string): Promise<void> {
  const session = sessionManager.getSession(depId);
  const buildSession = await repos.deployment.findBuildSessionByDeploymentId(depId);
  if (!buildSession || !session) return;
  await repos.deployment.persistBuildSessionLogs(buildSession.id, session.logs);
}

async function persistReleasePhase(
  dep: Deployment,
  phase: ReleasePhase,
  extra?: { meta?: Record<string, unknown> },
): Promise<void> {
  const applied = await repos.deployment.setReleasePhase(dep.id, phase, extra);
  if (!applied) throw cancelledError();
  dep.releasePhase = phase;
  if (extra?.meta) dep.meta = extra.meta as Deployment["meta"];
  await persistReleaseLogs(dep.id);
}

async function finish(
  dep: Deployment,
  status: "ready" | "failed" | "cancelled" | "no_changes",
  startedAt: number,
  error?: unknown,
) {
  const session = sessionManager.getSession(dep.id);
  const duration = Date.now() - startedAt;
  const errorMessage = error ? safeErrorMessage(error).slice(0, 2000) : undefined;
  const applied = await repos.deployment.updateStatus(dep.id, status, {
    buildDurationMs: duration,
    ...(errorMessage ? { errorMessage, errorCode: RELEASE_ERROR } : {}),
  });
  const settled = applied ? status : "cancelled";
  const buildSession = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
  const sseStatus = settled === "no_changes" ? "ready" : settled;
  if (buildSession) {
    await repos.deployment.finishBuildSession(
      buildSession.id,
      sseStatus,
      duration,
      session?.logs ?? [],
    );
  }
  if (applied || settled === "cancelled") {
    sessionManager.updateStatus(dep.id, sseStatus, {
      ...(errorMessage ? { errorMessage, errorCode: RELEASE_ERROR } : {}),
    });
  }
}

async function previousReadyLockHashes(
  project: Pick<Project, "activeReleaseDeploymentId">,
): Promise<Record<string, string> | null> {
  if (!project.activeReleaseDeploymentId) return null;
  const active = await repos.deployment.findById(project.activeReleaseDeploymentId);
  if (!active || active.status !== "ready") return null;
  return readMountedReleaseSnapshot(active)?.lockHashes ?? null;
}

async function transferUploadedArchive(
  executor: CommandExecutor,
  localPath: string,
  remoteArchive: string,
): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), "openship-upload-"));
  try {
    await copyFile(localPath, join(staging, "artifact"));
    const remoteDir = remoteArchive.replace(/\/+$/, "");
    await executor.mkdir(remoteDir);
    await executor.transferIn(staging, remoteDir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function runMountedRelease(
  ctx: RequestContext,
  project: Project,
  dep: Deployment,
  requestedCommit?: string,
  uploaded?: { localPath: string; sha256: string },
): Promise<void> {
  const startedAt = Date.now();
  const snapshot = readMountedReleaseSnapshot(dep) ?? null;
  const config = snapshot?.config ?? mountedReleaseConfig(project)!;
  const hostRoot = snapshot?.hostRoot ?? mountedReleaseHostRoot(project.id);
  const incoming = `${hostRoot}/.incoming-${dep.id}`;
  const releaseDir = snapshot?.releaseDir ?? releaseDirFor(project.id, dep.id);
  const authDir = `${hostRoot}/.auth-${dep.id}`;
  const builderName = releaseBuilderName(dep.id);
  const signal = beginDeployRun(dep.id);
  let previous = "";
  let committed = false;
  let token: string | undefined;
  let executor: CommandExecutor | null = null;

  const exec = (command: string, opts?: { timeout?: number }) =>
    execUnlessCancelled(executor!, signal, dep.id, command, opts);

  try {
    const building = await repos.deployment.updateStatus(dep.id, "building");
    if (!building) throw cancelledError();
    sessionManager.updateStatus(dep.id, "building");
    log(dep.id, "Preparing mounted code release");

    const runtime = await activeRuntime(project);
    const serverId =
      project.serverId ?? (runtime.deployment.meta as { serverId?: string } | null)?.serverId;
    executor = (await resolveServerExecutor(serverId ?? undefined, project.organizationId)).executor;
    const host = executor;
    const isUpload = Boolean(uploaded) || mountedReleaseBuildMode(config) === "upload";
    let resolvedSha = requestedCommit ? validateRef(requestedCommit, "commit SHA") : "";
    let remoteArchive: string | undefined;

    await persistReleasePhase(dep, "fetching");
    await assertReleaseNotCancelled(dep.id);
    await exec(
      `mkdir -p ${shellQuote(`${hostRoot}/releases`)} ${shellQuote(`${hostRoot}/shared`)} ${shellQuote(`${hostRoot}/builder-cache`)}`,
    );

    if (isUpload) {
      if (!uploaded) {
        throw new AppError(
          "Upload a release artifact to deploy this project. Webhooks do not activate upload-mode releases.",
          409,
          RELEASE_ERROR,
        );
      }
      log(dep.id, "Receiving local artifact");
      remoteArchive = `${hostRoot}/.incoming-${dep.id}-artifact`;
      await transferUploadedArchive(executor, uploaded.localPath, remoteArchive);
      await rm(dirname(uploaded.localPath), { recursive: true, force: true }).catch(() => {});
      await prepareRelease({
        exec,
        config,
        hostRoot,
        releaseDir,
        incoming,
        deploymentId: dep.id,
        uploadedArchive: `${remoteArchive}/artifact`,
        claimedSha256: uploaded.sha256,
        commitSha: resolvedSha || undefined,
        runPrepare: async () => {},
        log: (message) => log(dep.id, message),
      });
    } else {
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
        await exec(
          `chmod 700 ${shellQuote(authDir)} && chmod 600 ${shellQuote(`${authDir}/id`)} ${shellQuote(`${authDir}/known_hosts`)}`,
        );
      }
      let tokenAuth: Awaited<ReturnType<typeof materializeGitTokenAuth>> | undefined;
      if (credential.token && !credential.ssh && !credential.ambient) {
        tokenAuth = await materializeGitTokenAuth(
          shellGitSshWriter({
            exec: (cmd) => host.exec(cmd),
            writeSecret: (path, content) => host.writeFile(path, content),
          }),
          `${hostRoot}/.git-auth`,
          credential.token,
        );
      }
      const clone = assembleGitClone({
        repoUrl,
        gitToken: tokenAuth ? undefined : credential.token,
        gitTokenConfigFile: tokenAuth?.configFile,
        ambient: credential.ambient,
        ssh: credential.ssh
          ? { keyFile: `${authDir}/id`, knownHostsFile: `${authDir}/known_hosts` }
          : undefined,
      });

      await exec(
        `rm -rf ${shellQuote(incoming)} ${shellQuote(releaseDir)}; ` +
          `git init --bare ${shellQuote(`${hostRoot}/source.git`)} >/dev/null 2>&1 || true`,
      );
      const refspec = commit
        ? `+${commit}:refs/openship/${dep.id}`
        : `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
      try {
        await exec(
          `${clone.gitEnv} git ${clone.credFlag} --git-dir=${shellQuote(`${hostRoot}/source.git`)} ` +
            `fetch --force --prune --depth 50 ${shellQuote(clone.cloneUrl)} ${shellQuote(refspec)}`,
          { timeout: 120_000 },
        );
      } finally {
        await tokenAuth?.cleanup();
      }
      resolvedSha = (
        await exec(
          `git --git-dir=${shellQuote(`${hostRoot}/source.git`)} rev-parse ${shellQuote(commit ? `refs/openship/${dep.id}` : `refs/remotes/origin/${branch}`)}`,
        )
      ).trim();

      const alreadyLive = await findActiveSameShaRelease(project, resolvedSha);
      if (alreadyLive) {
        log(dep.id, `Release ${resolvedSha.slice(0, 7)} is already live`);
        await finish(dep, "no_changes", startedAt);
        return;
      }

      const tree = config.sourcePath?.replace(/^\/+|\/+$/g, "");
      await exec(
        `mkdir -p ${shellQuote(incoming)}; ` +
          `git --git-dir=${shellQuote(`${hostRoot}/source.git`)} archive ${shellQuote(tree ? `${resolvedSha}:${tree}` : resolvedSha)} ` +
          `| tar -x -C ${shellQuote(incoming)}; mv ${shellQuote(incoming)} ${shellQuote(releaseDir)}`,
        { timeout: 120_000 },
      );
    }

    let frozen = snapshot
      ? resolvedSha
        ? withSnapshotCommit(snapshot, resolvedSha)
        : snapshot
      : undefined;
    if (frozen) {
      dep.meta = { ...(dep.meta as Record<string, unknown>), mountedRelease: frozen };
    }
    await prepareSharedPaths(exec, hostRoot, releaseDir, frozen?.sharedPaths ?? config.sharedPaths ?? []);

    const containerRelease = `${config.containerPath}/releases/${dep.id}`;
    await exec(dockerExec(runtime.containerId, null, `test -d ${shellQuote(containerRelease)}`)).catch(
      () => {
        throw new AppError(
          "The runtime does not have the mounted release root yet. Rebuild runtime once, then deploy code.",
          409,
          "MOUNTED_RELEASE_MOUNT_REQUIRED",
        );
      },
    );

    await persistReleasePhase(dep, "preparing");
    await assertReleaseNotCancelled(dep.id);

    const prepared = await prepareRelease({
      exec,
      config,
      hostRoot,
      releaseDir,
      incoming,
      deploymentId: dep.id,
      uploadedArchive: uploaded ? `${remoteArchive}/artifact` : undefined,
      claimedSha256: uploaded?.sha256,
      commitSha: resolvedSha || undefined,
      previousLockHashes: await previousReadyLockHashes(project),
      previousReleaseDir: project.activeReleaseDeploymentId
        ? releaseDirFor(project.id, project.activeReleaseDeploymentId)
        : null,
      treeReady: true,
      log: (message) => log(dep.id, message),
      runPrepare: async () => {
        if (mountedReleaseBuildMode(config) !== "server" || !config.prepareCommand?.trim()) return;
        if (config.builderImage?.trim()) {
          log(dep.id, `Building release with ${config.builderImage}`);
          await prepareBuilderCachePaths(exec, hostRoot, config.builderCachePaths ?? []);
          await exec(builderRun(hostRoot, releaseDir, dep.id, config), { timeout: 900_000 });
        } else {
          log(dep.id, "Preparing release in the app container");
          await exec(dockerExec(runtime.containerId, containerRelease, config.prepareCommand), {
            timeout: 300_000,
          });
        }
      },
    });
    if (mountedReleaseBuildMode(config) === "prebuilt") {
      log(dep.id, "Using deployable files committed to Git");
    } else if (mountedReleaseBuildMode(config) === "upload") {
      log(dep.id, `Verified artifact ${prepared.sha256.slice(0, 12)}`);
    }
    if (frozen) {
      frozen = withSnapshotArtifact(frozen, {
        lockHashes: prepared.provenance.lockHashes,
        artifactSha256: prepared.sha256,
        artifactSource: prepared.provenance.source,
        commitSha: resolvedSha || frozen.commitSha,
      });
      dep.meta = { ...(dep.meta as Record<string, unknown>), mountedRelease: frozen };
    }

    const deploying = await repos.deployment.updateStatus(dep.id, "deploying");
    if (!deploying) throw cancelledError();
    sessionManager.updateStatus(dep.id, "deploying");
    previous = (
      await exec(`readlink ${shellQuote(`${hostRoot}/current`)} 2>/dev/null || true`)
    ).trim();
    await persistReleasePhase(dep, "activating", {
      meta: {
        ...(dep.meta as Record<string, unknown>),
        releasePreviousCurrent: previous || undefined,
      },
    });
    await execAndConfirm(
      executor,
      dep.id,
      `ln -sfn ${shellQuote(`releases/${dep.id}`)} ${shellQuote(`${hostRoot}/current.next`)} && ` +
        `mv -Tf ${shellQuote(`${hostRoot}/current.next`)} ${shellQuote(`${hostRoot}/current`)}`,
    );

    await persistReleasePhase(dep, "health");
    await assertReleaseNotCancelled(dep.id);
    log(dep.id, "Activated release; reloading the application");
    await runReload(exec, runtime.containerId, config);
    await assertReleaseNotCancelled(dep.id);
    await checkHealth(exec, runtime.containerId, config, runtime.healthPort);
    const publicHttps = await checkPublicHttps(exec, project.id, config);
    if (publicHttps.https === "failed") {
      throw new AppError(
        `Public HTTPS health check failed for ${publicHttps.hostname}.`,
        502,
        RELEASE_ERROR,
      );
    }
    await exec(markReleaseTreeReadOnlyCommand(releaseDir));

    const version = resolvedSha
      ? ((await repos.deployment.findReadyVersionByCommit(project.id, resolvedSha)) ??
        (await repos.deployment.getNextReadyVersion(project.id)))
      : await repos.deployment.getNextReadyVersion(project.id);
    const readyMeta = {
      ...(dep.meta as Record<string, unknown>),
      deploymentLane: "release",
      artifactKind: "mounted-tree",
      mountedReleaseRoot: releaseDir,
      mountedRelease: frozen,
      runtimeDeploymentId: snapshot?.runtimeDeploymentId ?? runtime.deployment.id,
      runtimeContainerId: runtime.containerId,
      releasePreviousCurrent: previous || undefined,
      publicHttps,
    };
    const applied = await repos.deployment.updateStatus(dep.id, "ready", {
      ...(resolvedSha ? { commitSha: resolvedSha } : {}),
      version,
      imageRef: null,
      meta: readyMeta,
    });
    if (!applied) {
      throw cancelledError();
    }
    const live = await repos.deployment.findById(dep.id);
    if (live?.status !== "ready") throw cancelledError();
    const advanced = await repos.project.setActiveReleaseDeploymentIfReady(project.id, dep.id);
    if (!advanced) throw cancelledError();
    committed = true;
    log(
      dep.id,
      resolvedSha
        ? `Code release ${resolvedSha.slice(0, 7)} is live`
        : `Code release ${prepared.sha256.slice(0, 12)} is live`,
    );
    await finish(dep, "ready", startedAt);
    await sweepMountedReleaseHost(executor, {
      ...project,
      activeReleaseDeploymentId: dep.id,
    }).catch(() => {});
  } catch (error) {
    const live = await repos.deployment.findById(dep.id);
    const cancelled = isCancelledError(error) || !live || live.status === "cancelled";
    if (executor && !committed && live?.status !== "ready") {
      await revertIfIncompleteActivation(executor, project.id, live ?? dep).catch(() => {});
      await abortMountedReleaseHostWork(executor, project.id, dep.id);
    }
    const message = safeErrorMessage(error).replaceAll(token ?? "\u0000", "[credential]");
    if (!cancelled) log(dep.id, message, "error");
    await finish(dep, cancelled ? "cancelled" : "failed", startedAt, cancelled ? undefined : new Error(message));
  } finally {
    if (executor) {
      for (const path of stagedReleaseCleanupPaths({
        ready: committed,
        incoming,
        authDir,
        releaseDir,
      })) {
        await removeHostPath(executor, path);
      }
      await removeHostPath(executor, `${hostRoot}/.incoming-${dep.id}-artifact`);
      await executor.exec(`docker rm -f ${shellQuote(builderName)}`).catch(() => {});
    }
    endDeployRun(dep.id);
    await releaseDeployLease(project.id, dep.id);
  }
}

export async function existingWebhookRelease(
  project: Pick<Project, "id" | "activeReleaseDeploymentId">,
  commitSha: string,
): Promise<Deployment | undefined> {
  const inFlight = await repos.deployment
    .findInProgressByCommit(project.id, commitSha)
    .catch(() => undefined);
  if (inFlight) return inFlight;
  if (!project.activeReleaseDeploymentId) return undefined;
  const active = await repos.deployment
    .findById(project.activeReleaseDeploymentId)
    .catch(() => null);
  if (active && compareCommitSha(active.commitSha, commitSha) === "same") return active;
  return undefined;
}

export async function triggerMountedRelease(
  ctx: RequestContext,
  projectId: string,
  opts?: {
    commitSha?: string;
    /** Defaults to release-rollback when a SHA is pinned, else code-release. */
    trigger?: string;
    plan?: ReleasePlan;
    serviceIds?: string[];
    changedPaths?: string[] | null;
  },
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (!mountedReleaseConfig(project)) {
    throw new AppError("Mounted releases are not enabled for this project.", 409, RELEASE_ERROR);
  }
  if (mountedReleaseBuildMode(mountedReleaseConfig(project)!) === "upload") {
    throw new AppError(
      "This project deploys from an uploaded artifact. Use POST /api/deployments/artifact.",
      409,
      RELEASE_ERROR,
    );
  }
  if (opts?.commitSha) {
    const existing = await findActiveSameShaRelease(project, opts.commitSha);
    if (existing) return existing;
  }
  await assertGitHubRepoAccess(ctx, { owner: project.gitOwner, repo: project.gitRepo });
  const trigger = opts?.trigger ?? (opts?.commitSha ? "release-rollback" : "code-release");
  const commitSha = await canonicalizeCommitRef(ctx, project, opts?.commitSha);
  if (trigger === "webhook" && commitSha) {
    const existing = await existingWebhookRelease(project, commitSha);
    if (existing) {
      console.log(
        `[Deploy] project ${project.id}: webhook code release for ${commitSha} skipped — already ${existing.status === "ready" ? "live" : "in progress"} (${existing.id}).`,
      );
      return existing;
    }
  }
  await checkNoActiveBuild(project.id);
  const live = mountedReleaseConfig(project)!;
  const runtime = await activeRuntime(project);
  const hostRoot = mountedReleaseHostRoot(project.id);
  const meta = {
    ...buildConfigSnapshot(project),
    deploymentLane: "release" as const,
    artifactKind: "mounted-tree" as const,
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
    commitSha,
    trigger,
    rollbackStrategy: "snapshot",
    plan: opts?.plan,
    serviceIds: opts?.serviceIds,
    changedPaths: opts?.changedPaths ?? null,
  });
  const contract = freezeMountedReleaseContract({
    config: live,
    commitSha,
    runtimeDeploymentId: runtime.deployment.id,
    hostRoot,
    releaseDir: releaseDirFor(project.id, dep.id),
  });
  const frozenMeta = {
    ...(dep.meta as Record<string, unknown>),
    deploymentLane: "release" as const,
    artifactKind: "mounted-tree" as const,
    mountedReleaseRoot: contract.releaseDir,
    runtimeDeploymentId: contract.runtimeDeploymentId,
    mountedRelease: contract,
  };
  dep.meta = frozenMeta;
  await repos.deployment.updateStatus(dep.id, "queued", { meta: frozenMeta, imageRef: null });
  sessionManager.createSession(dep.id, project.id);
  void runMountedRelease(ctx, project, dep, commitSha);
  return dep;
}

export async function triggerUploadedArtifact(
  ctx: RequestContext,
  projectId: string,
  uploaded: { localPath: string; sha256: string; commitSha?: string },
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (!mountedReleaseConfig(project)) {
    throw new AppError("Mounted releases are not enabled for this project.", 409, RELEASE_ERROR);
  }
  await checkNoActiveBuild(project.id);
  const live = mountedReleaseConfig(project)!;
  const runtime = await activeRuntime(project);
  const hostRoot = mountedReleaseHostRoot(project.id);
  const commitSha = uploaded.commitSha ? await canonicalizeCommitRef(ctx, project, uploaded.commitSha).catch(() => uploaded.commitSha) : undefined;
  const meta = {
    ...buildConfigSnapshot(project),
    deploymentLane: "release" as const,
    artifactKind: "mounted-tree" as const,
    runtimeDeploymentId: runtime.deployment.id,
    artifactSha256: uploaded.sha256,
    artifactSource: "local-upload" as const,
  };
  const dep = await createQueuedDeployment({
    projectId: project.id,
    organizationId: project.organizationId,
    branch: project.gitBranch || "main",
    environment: "production",
    framework: project.framework || "unknown",
    meta,
    envVars: null,
    commitSha,
    trigger: "artifact-upload",
    rollbackStrategy: "snapshot",
  });
  const contract = freezeMountedReleaseContract({
    config: live,
    commitSha,
    artifactSha256: uploaded.sha256,
    artifactSource: "local-upload",
    runtimeDeploymentId: runtime.deployment.id,
    hostRoot,
    releaseDir: releaseDirFor(project.id, dep.id),
  });
  const frozenMeta = {
    ...(dep.meta as Record<string, unknown>),
    deploymentLane: "release" as const,
    artifactKind: "mounted-tree" as const,
    mountedReleaseRoot: contract.releaseDir,
    runtimeDeploymentId: contract.runtimeDeploymentId,
    mountedRelease: contract,
    artifactSha256: uploaded.sha256,
    artifactSource: "local-upload" as const,
  };
  dep.meta = frozenMeta;
  await repos.deployment.updateStatus(dep.id, "queued", { meta: frozenMeta, imageRef: null });
  sessionManager.createSession(dep.id, project.id);
  void runMountedRelease(ctx, project, dep, commitSha, {
    localPath: uploaded.localPath,
    sha256: uploaded.sha256,
  });
  return dep;
}

export async function retainedReleaseTreeExists(
  executor: { exec: (command: string) => Promise<string> },
  target: Pick<Deployment, "id" | "imageRef" | "meta">,
): Promise<string | null> {
  const tree = mountedReleaseTreeRef(target);
  if (!tree) return null;
  const exists = (
    await executor.exec(`if [ -d ${shellQuote(tree)} ]; then echo yes; else echo no; fi`)
  )
    .trim()
    .endsWith("yes");
  return exists ? tree : null;
}

export function retainedReleaseNeedsRepository(
  target: Pick<Deployment, "id" | "imageRef" | "meta">,
): boolean {
  return mountedReleaseTreeRef(target) == null;
}

async function swapToRetainedRelease(
  project: Project,
  target: Deployment,
): Promise<Deployment> {
  await checkNoActiveBuild(project.id);
  const claimed = await claimDeployLease(project.id, target.id);
  if (!claimed) {
    throw new AppError("A deployment is already in progress.", 409, RELEASE_ERROR);
  }
  const hostRoot = mountedReleaseHostRoot(project.id);
  const config = readMountedReleaseSnapshot(target)?.config ?? mountedReleaseConfig(project);
  if (!config) {
    await releaseDeployLease(project.id, target.id);
    throw new AppError("Mounted releases are not enabled for this project.", 409, RELEASE_ERROR);
  }
  try {
    const runtime = await activeRuntime(project);
    const serverId =
      project.serverId ?? (runtime.deployment.meta as { serverId?: string } | null)?.serverId;
    const { executor } = await resolveServerExecutor(serverId ?? undefined, project.organizationId);
    const exec = (command: string, opts?: { timeout?: number }) => executor.exec(command, opts);
    const previous = (
      await exec(`readlink ${shellQuote(`${hostRoot}/current`)} 2>/dev/null || true`)
    ).trim();
    await exec(
      `ln -sfn ${shellQuote(`releases/${target.id}`)} ${shellQuote(`${hostRoot}/current.next`)} && ` +
        `mv -Tf ${shellQuote(`${hostRoot}/current.next`)} ${shellQuote(`${hostRoot}/current`)}`,
    );
    try {
      await runReload(exec, runtime.containerId, config);
      await checkHealth(exec, runtime.containerId, config, runtime.healthPort);
      const publicHttps = await checkPublicHttps(exec, project.id, config);
      if (publicHttps.https === "failed") {
        throw new AppError(
          `Public HTTPS health check failed for ${publicHttps.hostname}.`,
          502,
          RELEASE_ERROR,
        );
      }
      await repos.project.setActiveReleaseDeployment(project.id, target.id);
      await repos.deployment.updateStatus(target.id, "ready", {
        meta: {
          ...((target.meta ?? {}) as Record<string, unknown>),
          publicHttps,
        },
      });
      return (await repos.deployment.findById(target.id)) ?? target;
    } catch (error) {
      await revertReleaseCurrent(executor, hostRoot, previous || undefined).catch(() => {});
      await runReload(exec, runtime.containerId, config).catch(() => {});
      throw error;
    }
  } finally {
    await releaseDeployLease(project.id, target.id);
  }
}

export async function restoreMountedRelease(
  ctx: RequestContext,
  target: Deployment,
): Promise<Deployment> {
  if (!isMountedRelease(target)) {
    throw new AppError("This is not a mounted code release.", 409, RELEASE_ERROR);
  }
  const project = await repos.project.findById(target.projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, target.projectId);
  const runtime = await activeRuntime(project).catch(() => null);
  const serverId =
    project.serverId ?? (runtime?.deployment.meta as { serverId?: string } | null)?.serverId;
  const resolved = await resolveServerExecutor(serverId ?? undefined, project.organizationId).catch(
    () => null,
  );
  if (resolved && (await retainedReleaseTreeExists(resolved.executor, target))) {
    return swapToRetainedRelease(project, target);
  }
  if (!target.commitSha) {
    throw new AppError(
      "This uploaded release is no longer on disk and has no commit to rebuild from.",
      409,
      RELEASE_ERROR,
    );
  }
  return triggerMountedRelease(ctx, target.projectId, { commitSha: target.commitSha });
}

export function isMountedRelease(dep: Pick<Deployment, "meta">): boolean {
  return isMountedReleaseRow(dep) || releaseMeta(dep).deploymentLane === "release";
}

/** @returns false when the host was unreachable — keep the lease and retry later. */
export async function failCleanMountedRelease(
  project: Project,
  dep: Deployment,
  reason: string,
): Promise<boolean> {
  const serverId =
    project.serverId ?? (dep.meta as { serverId?: string } | null)?.serverId;
  const resolved = await resolveServerExecutor(serverId ?? undefined, project.organizationId).catch(
    () => null,
  );
  if (!resolved) return false;
  await revertIfIncompleteActivation(resolved.executor, project.id, dep).catch(() => {});
  await abortMountedReleaseHostWork(resolved.executor, project.id, dep.id);
  if (["queued", "building", "deploying"].includes(dep.status)) {
    await repos.deployment.updateStatus(dep.id, "failed", { errorMessage: reason });
    const session = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
    if (session && !session.finishedAt) {
      await repos.deployment.finishBuildSession(session.id, "failed", 0);
    }
  }
  return true;
}

export async function recoverInterruptedDeployments(reason: string): Promise<number> {
  const leased = await repos.project.listWithDeployLease();
  const inFlight = await repos.deployment.listInFlight();
  const seen = new Set<string>();
  const jobs: { project: Project; dep: Deployment }[] = [];
  let n = 0;

  for (const dep of inFlight) {
    const project = await repos.project.findById(dep.projectId);
    if (project) jobs.push({ project, dep });
    seen.add(dep.id);
  }
  for (const project of leased) {
    if (!project.deployLeaseId || seen.has(project.deployLeaseId)) continue;
    const dep = await repos.deployment.findById(project.deployLeaseId);
    if (dep) {
      jobs.push({ project, dep });
      continue;
    }
    await releaseDeployLease(project.id, project.deployLeaseId);
    n++;
  }
  for (const { project, dep } of jobs) {
    if (isMountedRelease(dep)) {
      const cleaned = await failCleanMountedRelease(project, dep, reason);
      if (!cleaned) continue;
    } else if (["queued", "building", "deploying"].includes(dep.status)) {
      await repos.deployment.updateStatus(dep.id, "cancelled", { errorMessage: reason });
      const session = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
      if (session && !session.finishedAt) {
        await repos.deployment.finishBuildSession(session.id, "cancelled", 0);
      }
    }
    await releaseDeployLease(project.id, dep.id);
    n++;
  }
  return n;
}
