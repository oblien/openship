import {
  createPlatform,
  type DockerConnectionOptions,
  type Platform,
  type RuntimeAdapter,
  type SshConfig,
} from "@repo/adapters";
import type { Deployment } from "@repo/db";
import { repos } from "@repo/db";
import type { DeployTarget, RuntimeMode } from "@repo/core";
import { env } from "../config";
import { getCloudToken } from "./cloud-client";
import { platform } from "./controller-helpers";
import { buildSshConfig, sshManager } from "./ssh-manager";

interface DeploymentMeta {
  deployTarget?: DeployTarget;
  runtimeMode?: RuntimeMode;
  serverId?: string;
}

export interface ResolvedDeploymentPlatform {
  platform: Platform;
  effectiveTarget: DeployTarget;
  runtimeMode: RuntimeMode;
  usesManagedRouting: boolean;
}

function localDockerTransport(): DockerConnectionOptions {
  return { transport: "socket" };
}

function resolveEffectiveTarget(base: Platform["target"], snapshot: DeploymentMeta): DeployTarget {
  if (base === "desktop") return snapshot.deployTarget ?? "cloud";
  if (base === "selfhosted") {
    // Explicit server ID → always SSH
    if (snapshot.serverId) return "server";
    // UI chose "server" target but serverId may be missing → still route to SSH
    if (snapshot.deployTarget === "server") return "server";
    return "local";
  }
  return "cloud";
}

function usesManagedRouting(base: Platform["target"], effectiveTarget: DeployTarget): boolean {
  return base === "selfhosted" || (base === "desktop" && (effectiveTarget === "server" || effectiveTarget === "local"));
}

async function resolveCloudPlatformForUser(userId?: string): Promise<Platform> {
  if (!userId) {
    throw new Error("Cannot resolve cloud deployment platform without a user ID");
  }

  const result = await getCloudToken(userId);
  if (!result) {
    throw new Error(
      "Cannot access cloud deployment: no cloud account linked. Connect your Oblien account in Settings.",
    );
  }

  return createPlatform({ target: "cloud", cloudToken: result.token });
}

export async function resolveDeploymentPlatform(
  snapshot: DeploymentMeta,
  opts?: { userId?: string; basePlatform?: Platform },
): Promise<ResolvedDeploymentPlatform> {
  const basePlatform = opts?.basePlatform ?? platform();
  const effectiveTarget = resolveEffectiveTarget(basePlatform.target, snapshot);
  const runtimeMode = snapshot.runtimeMode ?? (basePlatform.runtime.name === "docker" ? "docker" : "bare");

  if (effectiveTarget === "local" || effectiveTarget === "server") {
    const targetPlatform = await resolveTargetPlatform(effectiveTarget, runtimeMode, snapshot.serverId);
    return {
      platform: targetPlatform,
      effectiveTarget,
      runtimeMode,
      usesManagedRouting: usesManagedRouting(basePlatform.target, effectiveTarget),
    };
  }

  const needsUserScopedCloudPlatform =
    (effectiveTarget === "cloud" && !env.CLOUD_MODE && basePlatform.target !== "cloud") ||
    (!env.CLOUD_MODE && basePlatform.target === "cloud");

  const resolvedPlatform = needsUserScopedCloudPlatform
    ? await resolveCloudPlatformForUser(opts?.userId)
    : basePlatform;

  return {
    platform: resolvedPlatform,
    effectiveTarget,
    runtimeMode,
    usesManagedRouting: usesManagedRouting(basePlatform.target, effectiveTarget),
  };
}

// ─── Target → Platform factory ───────────────────────────────────────────────

/**
 * Resolve a full Platform for the given deploy target and runtime mode.
 *
 * Single entry point for all non-cloud target resolution.
 * Handles every cell in the matrix:
 *
 *               local                    server (SSH)
 *   bare    BareRuntime(LocalExec)   BareRuntime(SshExec)
 *   docker  DockerRuntime(socket)    DockerRuntime(ssh transport)
 *
 * Each cell also gets the matching routing (OpenResty) and system manager.
 * Cloud deployments go through the separate cloud-token flow.
 *
 * For server targets, the executor is acquired from `sshManager` (pooled,
 * idle-TTL, auto-retry) instead of creating a fresh SSH connection.
 */
export async function resolveTargetPlatform(
  target: "local" | "server",
  runtimeMode: RuntimeMode = "bare",
  serverId?: string,
): Promise<Platform> {
  // For SSH server targets, use the managed connection pool
  if (target === "server" && serverId) {
    const executor = await sshManager.acquire(serverId);

    // Still need SSH config for Docker SSH transport (dockerode uses its own connection)
    const server = await repos.server.get(serverId);
    const ssh = server?.sshHost ? await buildSshConfig(server) : null;

    return createPlatform({
      target: "selfhosted",
      runtime: runtimeMode,
      executor, // ← managed executor from pool
      ssh: ssh ?? undefined,
      docker: runtimeMode === "docker" && ssh
        ? toDockerSshTransport(ssh)
        : runtimeMode === "docker"
          ? localDockerTransport()
          : undefined,
    });
  }

  // Local target — no SSH, no pooling needed
  return createPlatform({
    target: "selfhosted",
    runtime: runtimeMode,
    docker: runtimeMode === "docker"
      ? localDockerTransport()
      : undefined,
  });
}

/** Map the shared SSH config → dockerode SSH transport options. */
function toDockerSshTransport(ssh: SshConfig): DockerConnectionOptions {
  return {
    transport: "ssh" as const,
    host: ssh.host,
    port: ssh.port,
    username: ssh.username,
    hostVerifier: ssh.hostVerifier,
    password: ssh.password,
    privateKey: ssh.privateKey,
    privateKeyPassphrase: ssh.privateKeyPassphrase,
    sshAgent: ssh.sshAgent,
  };
}

// ─── Per-deployment runtime resolution ───────────────────────────────────────

/**
 * Resolve the correct RuntimeAdapter for an existing deployment.
 *
 * Used by observability endpoints (logs, restart, stop, usage) that
 * need the runtime matching the deployment's original target.
 */
export async function resolveDeploymentRuntime(
  dep: Pick<Deployment, "meta" | "userId">,
): Promise<RuntimeAdapter> {
  const snapshot = (dep.meta ?? {}) as DeploymentMeta;
  const resolved = await resolveDeploymentPlatform(snapshot, { userId: dep.userId });
  return resolved.platform.runtime;
}
