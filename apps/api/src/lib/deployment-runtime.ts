import {
  createPlatform,
  DockerRuntime,
  resolveStaticOutputPath,
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
import { isLocalHostRow } from "./box-org";
import { resolveAcmeProviderOptions } from "./acme-config";

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
  /**
   * An OPT-IN readiness check that failed while the project's
   * `readiness.onFailure` was "warn" — the deploy is live and `ready`, and this
   * records what didn't answer.
   *
   * Deliberately NOT merged into `deployWarning`: any `deployWarning` makes the
   * project read `routingUnsynced` (see enrichProject), which offers "Retry
   * routing" — the wrong affordance for an app that didn't answer on its port.
   */
  readinessWarning?: string;
  /**
   * Advisory post-deploy static-output probe — the file-side twin of `portCheck`,
   * one entry per routed path. Point-in-time; never gates the deploy. An entry
   * that is `checked && (!found || !hasIndex)` is a 404 waiting to happen.
   */
  outputCheck?: OutputCheckResult[];
  /** Routed paths the operator dismissed from the output advisory. */
  outputCheckSkipped?: string[];
  /**
   * The outputDirectory this deployment is actually SERVED from, relative to its
   * release root — `""` when a Docker sandbox build already extracted the doc-root.
   *
   * Persisted because it CANNOT be recomputed after the fact: `resolveDeployRouting`
   * keys off the BUILD runtime (docker for a sandbox static) while `runtimeMode` is
   * persisted as the SERVE identity ("bare"), so a later recompute reads "bare" and
   * answers `project.outputDirectory` — pointing a probe at `<root>/dist` when the
   * edge serves `<root>`. Reading it back is the only way the check and the edge
   * agree on one path.
   */
  staticServeOutputDir?: string;
}

/**
 * The host directory a deployment SERVES static files from, or null when it isn't
 * a static one. THE one answer to that question outside the deploy pipeline — the
 * live route apply and the output-check probe both read it, and they have to agree:
 * the probe reports on the very directory the vhost was pointed at, so two copies
 * of this formula means the probe can pass on a path nothing serves (or fail on one
 * that works).
 *
 * `containerId` on a static-file-serve deployment is its release root on the host.
 * `staticServeOutputDir` MUST come from meta and is checked for PRESENCE, not
 * truthiness — `""` is the real answer for a Docker-sandbox build (which already
 * extracted the doc root), and treating it as absent points one directory too deep
 * at a path that doesn't exist. `?? project.outputDirectory` covers deployments
 * predating the field.
 *
 * Null for a project that runs a server (its routes are upstreams, not files), a
 * deployment with no release root, or an outputDirectory `resolveStaticOutputPath`
 * rejects as absolute/escaping.
 */
export function resolveDeploymentStaticRoot(
  deployment: Pick<Deployment, "containerId" | "meta">,
  project: { hasServer?: boolean | null; outputDirectory?: string | null },
): string | null {
  if (project.hasServer || !deployment.containerId) return null;
  const meta = (deployment.meta ?? {}) as DeploymentMeta;
  const outputDirectory = meta.staticServeOutputDir ?? project.outputDirectory ?? "";
  try {
    return resolveStaticOutputPath(deployment.containerId, outputDirectory);
  } catch {
    return null;
  }
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
      // Actionable, but deliberately org-AGNOSTIC in wording: never look the id
      // up outside this org. The strict org scope here IS the layer-1 host-root
      // gate (an isLocal row resolved cross-org would escalate any org to a
      // host-root executor), and the serverId comes from the client-supplied
      // deploy snapshot — probing it unscoped would also be a cross-tenant
      // existence/name oracle. So we explain the likely cause + recovery without
      // revealing whether the id exists elsewhere.
      throw new Error(
        "The selected deploy target isn't in this project's organization. This usually " +
          "happens after re-deploying Openship at the same URL (a stale session) or when " +
          "your active organization differs from the project's. Re-open the deploy target " +
          "picker and reselect a server, or switch your active organization to match, then redeploy.",
      );
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
  // AUTO-DETECT, don't hardcode per host platform: a deployment PINNED to a
  // specific server always routes over SSH to that server — whether the host is
  // a self-hosted box OR the DESKTOP app operating a remote server. Only the SaaS
  // (base "cloud") reaches its workloads via the cloud API instead of SSH. This
  // is what makes a desktop→remote-server deploy's edge/SSL run on the SERVER
  // (over SSH), not silently fall back to the laptop's noop provider.
  if (base !== "cloud" && snapshot.serverId) return "server";
  if (base === "desktop") return snapshot.deployTarget ?? "cloud";
  if (base === "selfhosted") {
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
    // ONE resolution for the server's executor + transport (isLocal → host
    // executor + socket docker; else → pooled SSH). Shared with
    // createServerDockerRuntime / createServerCommandExecutor — no drift.
    const { id, executor, isLocal, ssh } = await resolveServerExecutor(
      serverId,
      organizationId,
    );

    // The auto-registered "This Server" row IS the OpenShip host (VPS /
    // server-host mode): local host executor, host docker socket (DooD),
    // everything on-box.
    if (isLocal) {
      return createPlatform({
        target: "selfhosted",
        runtime: runtimeMode,
        executor,
        docker: runtimeMode === "docker" ? { transport: "socket" as const } : undefined,
        nginx: resolveAcmeProviderOptions(),
        provisionLock: createProvisionLock("provision:local"),
      });
    }

    return createPlatform({
      target: "selfhosted",
      runtime: runtimeMode,
      executor, // ← managed executor from pool
      ssh: ssh!,
      docker: runtimeMode === "docker" ? toDockerSshTransport(ssh!, executor) : undefined,
      nginx: resolveAcmeProviderOptions(),
      // Serialize provisioning per target server, so concurrent deploys (across
      // projects / single-app + compose) never race apt/openresty/networks/state.
      provisionLock: createProvisionLock(`provision:server:${id}`),
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
    nginx: resolveAcmeProviderOptions(),
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
  /** Undefined is allowed: `resolveServerExecutor` falls back to the org's single
   *  server, which is the same fallback a server-target deploy with no recorded
   *  serverId takes. Keeps that rule in ONE place. */
  serverId: string | undefined,
  organizationId: string,
): Promise<DockerRuntime> {
  const { executor, isLocal, ssh } = await resolveServerExecutor(serverId, organizationId);
  // isLocal ("This Server") → the host daemon over the local/mounted socket
  // (bare host, or DooD when the API is containerized) — no SSH bridge. Others
  // → dockerode over the pooled SSH connection.
  if (isLocal) {
    return DockerRuntime.create({ transport: "socket" });
  }
  return DockerRuntime.create(toDockerSshTransport(ssh!, executor));
}

/**
 * THE single server → {executor, endpoint, transport} resolver. One place
 * decides how to reach a server, so resolveTargetPlatform (deploy),
 * createServerDockerRuntime (docker/migrate), and createServerCommandExecutor
 * (direct transfer) never drift:
 *   - isLocal "This Server" → the LOCAL host executor (createHostExecutor:
 *     LocalExecutor bare / SSH→host when containerized) + host docker socket;
 *     `ssh` is null (no bridge). Closes the gap where callers assumed SSH.
 *   - remote → the pooled SSH executor + its decrypted SshConfig.
 * `conn` is the box's SSH endpoint as a PEER would dial it (a placeholder for an
 * isLocal peer — the direct-transfer both-direction probe routes around it by
 * making the local box the initiator).
 */
export async function resolveServerExecutor(
  serverId: string | undefined,
  organizationId: string | undefined,
): Promise<{
  id: string;
  executor: CommandExecutor;
  conn: { host: string; port: number; user: string };
  isLocal: boolean;
  ssh: SshConfig | null;
}> {
  const server = await resolveOrgServer(serverId, organizationId);
  const conn = {
    host: server.sshHost || "127.0.0.1",
    port: server.sshPort ?? 22,
    user: server.sshUser || "root",
  };
  // isLocal "This Server" OR a row that actually points at THIS host (a plain SSH
  // row for the local box — loopback / SERVER_IP — in the box-owning org). Both
  // resolve to the local host executor + mounted docker socket (DooD); dialing SSH
  // to them hits the API's own loopback (no sshd) — the "Can't reach 127.0.0.1"
  // failure. Org-gated (isLocalHostRow) so a teammate's org can't mint a host-root
  // target from a loopback row.
  if (await isLocalHostRow(server)) {
    // Self-heal the persisted flag so EVERY `server.isLocal` consumer (edge,
    // domains, tunnels, the servers list) agrees — not just this resolver.
    // One-time, idempotent, best-effort; never blocks or fails the deploy.
    if (!server.isLocal) {
      repos.server.update(server.id, { isLocal: true }).catch(() => {});
    }
    // POOLED, not a fresh `createHostExecutor()`. This executor outlives the call
    // (the deploy holds it), so it can't be scoped with `withHostExecutor` — but
    // `acquire` returns the shared host channel for a local row, which is what
    // stops one deploy from leaving behind an sshd session (#291).
    return {
      id: server.id,
      executor: await sshManager.acquire(server.id),
      conn,
      isLocal: true,
      ssh: null,
    };
  }
  const executor = await sshManager.acquire(server.id);
  const ssh = server.sshHost ? await buildSshConfig(server) : null;
  if (!ssh) {
    throw new Error("Invalid SSH configuration. Check host, auth method, and credentials.");
  }
  return { id: server.id, executor, conn, isLocal: false, ssh };
}

/**
 * A server's raw CommandExecutor + SSH endpoint, for the direct
 * server-to-server migration transfer. Thin façade over resolveServerExecutor.
 */
export async function createServerCommandExecutor(
  serverId: string,
  organizationId: string,
): Promise<{ executor: CommandExecutor; conn: { host: string; port: number; user: string }; isLocal: boolean }> {
  const { executor, conn, isLocal } = await resolveServerExecutor(serverId, organizationId);
  return { executor, conn, isLocal };
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

/**
 * The RUNTIME ALONE for a deployment — for READ paths (live container state,
 * logs, usage) that never provision anything.
 *
 * `resolveDeploymentRuntime` above picks `.runtime` off a FULL platform, and
 * building that platform is not free: on a bare self-hosted box `createPlatform`
 * eagerly constructs the infra provider, which runs `detectOpenRestyPaths` and
 * then re-asserts the nginx.conf include + self-heals the edge Lua — inside the
 * `provision:local` provision lock. Fine for a deploy; wrong for a POLLED read,
 * which only needs one `docker ps`, and which then contends with any in-flight
 * deploy holding that lock (that contention is how service status timed out and
 * rendered "unknown" while the containers were up).
 *
 * The target decision is NOT re-derived here: `resolveEffectiveTarget` stays the
 * one authority (so `deployTarget:"server"` with no recorded serverId, and a
 * desktop deployment with no deployTarget, both resolve exactly as a deploy
 * would), and the server→docker transport stays `createServerDockerRuntime`.
 * Only cloud keeps the platform path — its runtime is an Oblien HTTP client with
 * no executor and no OpenResty, so there is nothing to skip.
 *
 * Callers own `runtime.dispose()` (tears down the SSH loopback bridge; no-op on
 * the socket transport).
 */
export async function resolveDeploymentRuntimeForRead(
  dep: Pick<Deployment, "meta" | "organizationId">,
): Promise<{ runtime: RuntimeAdapter; serverId: string | null }> {
  // Services are containers even when the app itself deploys "bare" — pin docker
  // so a bare project's sidecars still resolve a docker runtime (matches
  // resolveServicePlatform's long-standing behaviour).
  const snapshot = { ...((dep.meta ?? {}) as DeploymentMeta), runtimeMode: "docker" as const };
  const effectiveTarget = resolveEffectiveTarget(platform().target, snapshot);

  if (effectiveTarget === "server") {
    return {
      runtime: await createServerDockerRuntime(snapshot.serverId, dep.organizationId),
      // Same value resolveDeploymentPlatform reports: the RECORDED id, which
      // streaming callers use to retain/release the pooled SSH connection.
      serverId: snapshot.serverId ?? null,
    };
  }
  if (effectiveTarget === "local") {
    return { runtime: await DockerRuntime.create({ transport: "socket" }), serverId: null };
  }
  const resolved = await resolveDeploymentPlatform(snapshot, {
    organizationId: dep.organizationId,
  });
  return { runtime: resolved.platform.runtime, serverId: resolved.serverId };
}
