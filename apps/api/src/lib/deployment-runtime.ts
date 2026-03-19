import { createPlatform, type Platform, type RuntimeAdapter, type SshConfig } from "@repo/adapters";
import type { Deployment } from "@repo/db";
import { repos } from "@repo/db";
import type { DeployTarget, RuntimeMode } from "@repo/core";
import { env } from "../config";
import { getCloudToken } from "./cloud-client";
import { platform } from "./controller-helpers";
import { buildSshConfig } from "./ssh-manager";

interface DeploymentMeta {
  deployTarget?: DeployTarget;
  runtimeMode?: RuntimeMode;
  serverId?: string;
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
 * Each cell also gets the matching routing (Traefik) and system manager.
 * Cloud deployments go through the separate cloud-token flow.
 */
export async function resolveTargetPlatform(
  target: "local" | "server",
  runtimeMode: RuntimeMode = "bare",
  serverId?: string,
): Promise<Platform> {
  if (target === "server") {
    // Look up by explicit ID — the `servers` table is the single source of truth.
    const server = serverId
      ? await repos.server.get(serverId)
      : null;
    if (!server?.sshHost) {
      throw new Error("No server configured. Add your SSH server in Settings.");
    }
    const ssh = await buildSshConfig(server);
    if (!ssh) {
      throw new Error("Invalid SSH configuration. Check host, auth method, and credentials.");
    }

    // Docker runtime talks to the Docker daemon over SSH (dockerode transport)
    const docker = runtimeMode === "docker"
      ? sshToDockerTransport(ssh)
      : undefined;

    return createPlatform({ target: "selfhosted", ssh, runtime: runtimeMode, docker });
  }

  // Local — no SSH, executor runs on this machine
  return createPlatform({ target: "selfhosted", runtime: runtimeMode });
}

/** Map adapters SshConfig → Docker SSH transport config. */
function sshToDockerTransport(ssh: SshConfig) {
  return {
    transport: "ssh" as const,
    host: ssh.host,
    port: ssh.port,
    username: ssh.username,
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
  const plat = platform();
  const snapshot = (dep.meta ?? {}) as DeploymentMeta;
  const effectiveTarget = plat.target === "desktop"
    ? snapshot.deployTarget ?? "cloud"
    : plat.target;
  const runtimeMode = snapshot.runtimeMode ?? "bare";
  const serverId = snapshot.serverId;

  // Local or Server → resolveTargetPlatform handles both
  if (
    effectiveTarget === "local" ||
    (effectiveTarget === "server" && plat.target === "desktop")
  ) {
    const targetPlat = await resolveTargetPlatform(effectiveTarget, runtimeMode, serverId);
    return targetPlat.runtime;
  }

  // Cloud → needs per-user token
  const needsCloudToken =
    (effectiveTarget === "cloud" && !env.CLOUD_MODE && plat.target !== "cloud") ||
    (!env.CLOUD_MODE && plat.target === "cloud");

  if (!needsCloudToken) {
    return plat.runtime;
  }

  const result = await getCloudToken(dep.userId);
  if (!result) {
    throw new Error(
      "Cannot access cloud deployment: no cloud account linked. Connect your Oblien account in Settings.",
    );
  }

  const cloudPlatform = await createPlatform({ target: "cloud", cloudToken: result.token });
  return cloudPlatform.runtime;
}
