import {
  createPlatform,
  createHostExecutor,
  DockerRuntime,
  type CommandExecutor,
  type DockerConnectionOptions,
  type Platform,
  type RuntimeAdapter,
  type SshConfig,
} from "@repo/adapters";
import type { Deployment } from "@repo/db";
import { repos } from "@repo/db";
import type { DeployTarget, RuntimeMode } from "@repo/core";
import { env } from "../config";
import { cloudClient, getOrgCloudToken } from "./cloud/client";
import { resolveOrgCloudUserId } from "./cloud/transport";
import { platform } from "./controller-helpers";
import { buildSshConfig, sshManager } from "./ssh-manager";
import { createProvisionLock } from "./provision-lock";

/**
 * The shape of `deployment.meta` JSONB. Snapshotted per-deploy —
 * historical for any given deployment row, not a live binding.
 * Persistent bindings live on the project row (e.g.
 * `project.cloud_workspace_id`); meta is the source for one-time
 * info the build pipeline needs to remember.
 */
export interface DeploymentMeta {
  deployTarget?: DeployTarget;
  runtimeMode?: RuntimeMode;
  serverId?: string;
  /**
   * Adopt an already-running, externally-supervised process instead of building
   * + starting one. Set for the self-deployed control plane (the "openship"
   * self-app): the deployment is real (row + activeDeploymentId + routes/SSL via
   * the normal pipeline) but the bare runtime never starts a unit. Inert for
   * `resolveEffectiveTarget`; only the runtime's deploy step reads it (via the
   * `adopt` flag threaded onto DeployConfig).
   */
  adopt?: boolean;
  /**
   * Release/dist-source deploy: the semver version this deployment shipped
   * (no leading "v"). Captured in the snapshot by `applyReleaseSourceToSnapshot`
   * and promoted to the `deployment.release_version` column onSuccess — the
   * drift banner's `current` anchor.
   */
  releaseVersion?: string;
  /**
   * "local" | "server" — where the build runs. A local build targeting cloud
   * keeps the project LOCAL-canonical and uploads the output to a cloud
   * workspace (no promote/transfer); see resolveEffectiveTarget.
   */
  buildStrategy?: "local" | "server";
  /** Cloud workspace this deployment provisioned (cloud target only). */
  workspaceId?: string;
  /**
   * Advisory post-deploy port probe — one entry per exposed port (single-app)
   * or exposed service (compose). Point-in-time; never gates the deploy. The
   * dashboard raises a skippable "is that the right port?" modal for any entry
   * that is `checked && !listening`.
   */
  portCheck?: PortCheckResult[];
  /**
   * Ports (single-app) or service ids (compose) the operator dismissed from the
   * port advisory, so it doesn't re-nag after a refresh.
   */
  portCheckSkipped?: (number | string)[];
}

/** One exposed port's advisory probe outcome (persisted in `deployment.meta`). */
export interface PortCheckResult {
  /** The exposed/public port that was probed. */
  port: number;
  /** True if a listener was found inside the instance. */
  listening: boolean;
  /** False = probe inconclusive (runtime can't exec inside / probe errored) — no advisory. */
  checked: boolean;
  /** Compose only: which service this result belongs to. */
  serviceId?: string;
  serviceName?: string;
  /** Set when the probe was intentionally not run for this target. */
  skippedReason?: "not-exposed" | "no-exec" | "no-port";
}

/** Advisory static-output audit result — the file-side counterpart to
 *  PortCheckResult. `path` is the routed targetPath ("/" or "/foo"). */
export interface OutputCheckResult {
  path: string;
  /** The resolved on-disk/served location that was probed. */
  servedPath?: string;
  /** The served path exists. */
  found: boolean;
  /** A servable index is present (file, or dir with index.html). */
  hasIndex: boolean;
  /** False = probe inconclusive (runtime can't exec / errored) — no advisory. */
  checked: boolean;
  skippedReason?: "no-exec" | "no-output-dir";
}

export interface ResolvedDeploymentPlatform {
  platform: Platform;
  effectiveTarget: DeployTarget;
  runtimeMode: RuntimeMode;
  usesManagedRouting: boolean;
  /** The server ID used for SSH targets (null for local/cloud). */
  serverId: string | null;
}

type OrgServer = NonNullable<Awaited<ReturnType<typeof repos.server.getInOrganization>>>;

/**
 * Resolve the org's deploy-target server and RETURN THE ROW (not just the
 * id) — the single org-scoped lookup the caller needs, so there's no
 * second fetch and no non-org fallback path.
 *
 * Server selection is strictly org-scoped: an explicit serverId is verified
 * to belong to the org (the deploy snapshot's serverId comes from the
 * request body and is NOT validated by the route tag — IDOR guard), and an
 * implicit selection only ever considers THIS org's servers.
 */
async function resolveOrgServer(
  serverId: string | undefined,
  organizationId: string | undefined,
): Promise<OrgServer> {
  if (!organizationId) {
    throw new Error(
      "Cannot resolve a server deployment target without an organization ID",
    );
  }

  if (serverId) {
    const server = await repos.server.getInOrganization(serverId, organizationId);
    if (!server) {
      throw new Error("Deployment target server not found in this organization.");
    }
    return server;
  }

  const servers = await repos.server.listByOrganization(organizationId);
  if (servers.length === 1 && servers[0]) {
    return servers[0];
  }

  if (servers.length === 0) {
    throw new Error("No server configured. Add your SSH server in Settings.");
  }

  throw new Error("Deployment target is a server, but this deployment has no server ID. Redeploy and select a server explicitly.");
}

/**
 * THE authority for "given the host platform + this deployment's snapshot,
 * where does it actually land?". Returns a concrete DeployTarget
 * ("local" | "server" | "cloud") — never the host platform literal. Preflight
 * and the build pipeline both route through this so their notion of the target
 * can never drift (a drift caused the self-hosted→cloud-preflight 403).
 */
export function resolveEffectiveTarget(base: Platform["target"], snapshot: DeploymentMeta): DeployTarget {
  if (base === "desktop") return snapshot.deployTarget ?? "cloud";
  if (base === "selfhosted") {
    // Explicit server ID → always SSH
    if (snapshot.serverId) return "server";
    // UI chose "server" target but serverId may be missing → still route to SSH
    if (snapshot.deployTarget === "server") return "server";
    // Local-orchestrated cloud deploy: build on THIS host, upload the output to
    // an Openship Cloud workspace, and run it there — the project stays
    // local-canonical (no promote/transfer). This is the ONLY combo that keeps
    // the cloud target on a self-hosted box; a server-build cloud deploy is
    // promoted to the SaaS earlier (deployment.controller) and never reaches here.
    if (snapshot.deployTarget === "cloud" && snapshot.buildStrategy === "local") return "cloud";
    return "local";
  }
  return "cloud";
}

export function usesManagedRouting(base: Platform["target"], effectiveTarget: DeployTarget): boolean {
  // Managed (local OpenResty) routing applies only to on-box targets. A cloud
  // target — including the local-orchestrated cloud deploy — routes via cloud
  // pages/edge, not the local proxy.
  return (
    (effectiveTarget === "server" || effectiveTarget === "local") &&
    (base === "selfhosted" || base === "desktop")
  );
}

/**
 * Resolve a cloud-target Platform using ANY cloud-linked org member's
 * token. The deployment doesn't carry a user_id anymore — its
 * `organization_id` is the source of truth. We pick whichever member
 * has linked their Openship Cloud account and use their token to mint
 * cloud requests on behalf of the org.
 */
async function resolveCloudPlatformForOrg(organizationId?: string): Promise<Platform> {
  if (!organizationId) {
    throw new Error("Cannot resolve cloud deployment platform without an organization ID");
  }

  const result = await getOrgCloudToken(organizationId);
  if (!result) {
    // getOrgCloudToken returns null for TWO different reasons — don't conflate
    // them. A link that exists but couldn't mint a token means Cloud is
    // unreachable / the session lapsed (transient, retryable); only a missing
    // link is genuinely "not connected".
    const linkedUserId = await resolveOrgCloudUserId(organizationId).catch(() => null);
    throw new Error(
      linkedUserId
        ? "Openship Cloud is unreachable right now — couldn't validate the linked session. Check the connection in Settings and try again."
        : "No member of this organization has linked Openship Cloud. Connect via Settings.",
    );
  }

  return createPlatform({
    target: "cloud",
    cloudToken: result.token,
    cloudAdminProxy: {
      createPage: (input) => cloudClient({ organizationId }).pages.create(input),
      disablePage: (slug) => cloudClient({ organizationId }).pages.disable(slug),
      enablePage: (slug) => cloudClient({ organizationId }).pages.enable(slug),
      deletePage: (slug) => cloudClient({ organizationId }).pages.delete(slug),
    },
  });
}

export async function resolveDeploymentPlatform(
  snapshot: DeploymentMeta,
  opts?: { organizationId?: string; basePlatform?: Platform },
): Promise<ResolvedDeploymentPlatform> {
  const basePlatform = opts?.basePlatform ?? platform();
  const effectiveTarget = resolveEffectiveTarget(basePlatform.target, snapshot);
  const runtimeMode = snapshot.runtimeMode ?? (basePlatform.runtime.name === "docker" ? "docker" : "bare");

  if (effectiveTarget === "local" || effectiveTarget === "server") {
    const resolvedServerId = effectiveTarget === "server" ? (snapshot.serverId ?? null) : null;
    const targetPlatform = await resolveTargetPlatform(
      effectiveTarget,
      runtimeMode,
      snapshot.serverId,
      opts?.organizationId,
    );
    return {
      platform: targetPlatform,
      effectiveTarget,
      runtimeMode,
      usesManagedRouting: usesManagedRouting(basePlatform.target, effectiveTarget),
      serverId: resolvedServerId,
    };
  }

  // Invariant (cloud-as-source): a multi-user self-hosted server never reaches
  // a cloud target here — resolveEffectiveTarget() collapses cloud→local/server
  // for the "selfhosted" base, and cloud projects are proxied to the SaaS by the
  // gateway before the pipeline runs. So the cloud-platform resolution below is
  // only ever reached by the SaaS itself (basePlatform.target === "cloud") or by
  // desktop (single-user, owner-driven) — never by a self-hosted server. That is
  // what keeps the local cloud-capability path (pages/managed edge) off a
  // self-hosted box.
  const needsOrgScopedCloudPlatform =
    (effectiveTarget === "cloud" && !env.CLOUD_MODE && basePlatform.target !== "cloud") ||
    (!env.CLOUD_MODE && basePlatform.target === "cloud");

  const resolvedPlatform = needsOrgScopedCloudPlatform
    ? await resolveCloudPlatformForOrg(opts?.organizationId)
    : basePlatform;

  return {
    platform: resolvedPlatform,
    effectiveTarget,
    runtimeMode,
    usesManagedRouting: usesManagedRouting(basePlatform.target, effectiveTarget),
    serverId: null,
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
  organizationId?: string,
): Promise<Platform> {
  // For SSH server targets, use the managed connection pool
  if (target === "server") {
    // One org-scoped resolution — returns the verified row, so no second
    // fetch and no non-org fallback. (resolveOrgServer throws if the org
    // is missing or the server isn't in it.)
    const server = await resolveOrgServer(serverId, organizationId);

    // The auto-registered "This Server" row IS the OpenShip host (VPS /
    // server-host mode). It has no real SSH — resolve it to the LOCAL host
    // executor (createHostExecutor: LocalExecutor when bare, SSH→host when the
    // API is containerized), exactly like the self-deploy path. Docker uses the
    // host's socket (DooD). Everything downstream (routing/SSL) is on-box.
    if (server.isLocal) {
      return createPlatform({
        target: "selfhosted",
        runtime: runtimeMode,
        executor: createHostExecutor(),
        docker: runtimeMode === "docker" ? { transport: "socket" as const } : undefined,
        provisionLock: createProvisionLock("provision:local"),
      });
    }

    const executor = await sshManager.acquire(server.id);

    // SSH config for the Docker SSH transport (dockerode uses its own connection).
    const ssh = server.sshHost ? await buildSshConfig(server) : null;

    if (!ssh) {
      throw new Error("Invalid SSH configuration. Check host, auth method, and credentials.");
    }

    return createPlatform({
      target: "selfhosted",
      runtime: runtimeMode,
      executor, // ← managed executor from pool
      ssh,
      docker: runtimeMode === "docker"
        ? toDockerSshTransport(ssh, executor)
        : undefined,
      // Serialize provisioning per target server, so concurrent deploys (across
      // projects / single-app + compose) never race apt/openresty/networks/state.
      provisionLock: createProvisionLock(`provision:server:${server.id}`),
    });
  }

  // Local target - no SSH, no pooling needed. Still serialize provisioning: two
  // local deploys share the same host's openresty/docker/state.
  return createPlatform({
    target: "selfhosted",
    runtime: runtimeMode,
    docker: runtimeMode === "docker"
      ? { transport: "socket" as const }
      : undefined,
    provisionLock: createProvisionLock("provision:local"),
  });
}

/**
 * Build a DockerRuntime pointed at an org server's Docker daemon over SSH, for
 * READ-ONLY inspection (migrating an existing Docker deployment into Openship).
 *
 * Unlike `resolveTargetPlatform`, this skips routing/ssl/system managers and the
 * provision lock — inspection never provisions. The dockerode calls multiplex
 * over the server's pooled SSH connection. Callers MUST `await rt.dispose()` to
 * tear down the loopback bridge; the pooled executor itself is owned by
 * `sshManager` and is left intact.
 */
export async function createServerDockerRuntime(
  serverId: string,
  organizationId: string,
): Promise<DockerRuntime> {
  const server = await resolveOrgServer(serverId, organizationId);
  const executor = await sshManager.acquire(server.id);
  const ssh = server.sshHost ? await buildSshConfig(server) : null;
  if (!ssh) {
    throw new Error("Invalid SSH configuration. Check host, auth method, and credentials.");
  }
  return DockerRuntime.create(toDockerSshTransport(ssh, executor));
}

/** Map the shared SSH config → dockerode SSH transport options with pooled executor. */
function toDockerSshTransport(ssh: SshConfig, executor: CommandExecutor): DockerConnectionOptions {
  return {
    transport: "ssh" as const,
    executor, // ← reuses the pooled SSH connection for Docker API calls
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
 *
 * Returns `serverId` so callers can retain/release the SSH connection
 * for long-lived operations (streaming).
 */
export async function resolveDeploymentRuntime(
  dep: Pick<Deployment, "meta" | "organizationId">,
): Promise<{
  runtime: RuntimeAdapter;
  /**
   * Routing provider for the deployment's ACTUAL host — the local box, or a
   * remote server/sandbox over SSH. This is the single, reused routing the
   * deploy pipeline uses; callers that re-apply routes on edit MUST use it
   * rather than the global `platform()` singleton (which only ever targets the
   * orchestrator's local openresty).
   */
  routing: Platform["routing"];
  effectiveTarget: DeployTarget;
  serverId: string | null;
}> {
  const snapshot = (dep.meta ?? {}) as DeploymentMeta;
  const resolved = await resolveDeploymentPlatform(snapshot, {
    organizationId: dep.organizationId,
  });
  return {
    runtime: resolved.platform.runtime,
    routing: resolved.platform.routing,
    effectiveTarget: resolved.effectiveTarget,
    serverId: resolved.serverId,
  };
}
