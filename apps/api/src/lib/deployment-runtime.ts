import {
  createPlatform,
  DockerRuntime,
  isHostChannelUnavailableError,
  peekPlatform,
  resolveStaticOutputPath,
  unavailableExecutor,
  type CommandExecutor,
  type DockerConnectionOptions,
  type Platform,
  type RuntimeAdapter,
  type SshConfig,
} from "@repo/adapters";
import type { Deployment } from "@repo/db";
import { repos } from "@repo/db";
import {
  HOST_CHANNEL_UNAFFECTED,
  HostUnreachableError,
  resolveWorkload,
  safeErrorMessage,
  type DeployTarget,
  type RuntimeMode,
} from "@repo/core";
import { env } from "../config";
import { isRealContainerRef } from "./container-ref";
import { cloudClient, getOrgCloudToken } from "./cloud/client";
import { resolveOrgCloudUserId } from "./cloud/transport";
import { platform } from "./controller-helpers";
import { buildSshConfig, sshManager } from "./ssh-manager";
import { createProvisionLock } from "./provision-lock";
import { isLocalHostRow } from "./box-org";
import { isConnectionLoss } from "./remote-state";
import { resolveAcmeProviderOptions } from "./acme-config";
import { findLocalServer } from "./startup/self-server";
import { registryAuthResolver } from "../modules/credentials/registry-auth";
import {
  LOCAL_HOST_PORT_TARGET,
  resolveHostPortTargetIdentity,
  type HostPortConnectionLocator,
  type HostPortTargetIdentity,
} from "./host-port-target";

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
  /** Raw upstream release tag and the concrete prebuilt image frozen for a
   * container-release deployment. */
  releaseTag?: string;
  releaseImageRef?: string;
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
  /** Compose roll-up. Loosely typed on purpose — the pipeline writes a wider
   *  object than any one reader needs. */
  composeDeployment?: { warningMessage?: string } & Record<string, unknown>;
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
  project: {
    hasServer?: boolean | null;
    workloadType?: string | null;
    outputDirectory?: string | null;
  },
): string | null {
  // Only a STATIC workload serves a release directory. A worker also has
  // `hasServer=false` but its containerId is a real container, not a doc-root, so
  // classify by workload — not the legacy boolean — or a worker's stop/start would
  // dial a bogus static path (#538-B).
  if (
    resolveWorkload(project.workloadType, project.hasServer) !== "static" ||
    !deployment.containerId
  ) {
    return null;
  }
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
  /**
   * Status the EDGE answered for a real request to this route. Absent = no HTTP
   * signal (nothing to ask as, no curl, nothing accepted the connection).
   *
   * The filesystem fields say the bytes are reachable from where the edge looks;
   * this says the edge actually serves them — the one check that catches
   * unreadable file modes and a vhost that was never written.
   */
  status?: number;
  /**
   * The edge answered and it was not a failure (2xx/3xx, or 401/403 where a policy
   * answered a route that DID resolve). ABSENT = no signal — readers must test
   * `served === false`, never `!served`, or every pre-existing record with no HTTP
   * half reads as broken.
   */
  served?: boolean;
  skippedReason?: "no-exec" | "no-output-dir";
}

export interface ResolvedDeploymentPlatform {
  platform: Platform;
  effectiveTarget: DeployTarget;
  runtimeMode: RuntimeMode;
  usesManagedRouting: boolean;
  /** The server ID used for SSH targets (null for local/cloud). */
  serverId: string | null;
  /** Physical TCP bind namespace used by durable claims and allocation locks. */
  hostPortTarget: HostPortTargetIdentity | null;
}

type OrgServer = NonNullable<Awaited<ReturnType<typeof repos.server.getInOrganization>>>;
type ResolvedServerTarget = Awaited<ReturnType<typeof resolveServerExecutor>>;

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
    throw new Error("Cannot resolve a server deployment target without an organization ID");
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
        "This project's deploy target is no longer available. That server may have been " +
          "removed from Openship (deleting one unbinds its projects), or this is a stale " +
          "session after re-deploying Openship at the same URL, or your active organization " +
          "differs from the project's. Re-open the deploy target picker and reselect a " +
          "server, or switch your active organization to match, then redeploy.",
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

  throw new Error(
    "Deployment target is a server, but this deployment has no server ID. Redeploy and select a server explicitly.",
  );
}

async function resolveServerTargetTopology(
  serverId: string | undefined,
  organizationId: string | undefined,
): Promise<{ server: OrgServer; isLocal: boolean }> {
  const server = await resolveOrgServer(serverId, organizationId);
  return { server, isLocal: await isLocalHostRow(server) };
}

/**
 * Read-only transport topology for preflight. It uses the same org-scoped
 * server selection and local-host predicate as runtime construction, without
 * acquiring an SSH/host executor merely to answer where Docker source can run.
 */
export async function resolvePlannedTargetTopology(
  target: DeployTarget,
  serverId: string | undefined,
  organizationId: string | undefined,
): Promise<{
  serverId: string | null;
  dockerTransport: "socket" | "ssh" | undefined;
}> {
  if (target === "local") return { serverId: null, dockerTransport: "socket" };
  if (target !== "server") return { serverId: null, dockerTransport: undefined };
  const { server, isLocal } = await resolveServerTargetTopology(serverId, organizationId);
  return {
    serverId: server.id,
    dockerTransport: isLocal ? "socket" : "ssh",
  };
}

/**
 * THE authority for "given the host platform + this deployment's snapshot,
 * where does it actually land?". Returns a concrete DeployTarget
 * ("local" | "server" | "cloud") — never the host platform literal. Preflight
 * and the build pipeline both route through this so their notion of the target
 * can never drift (a drift caused the self-hosted→cloud-preflight 403).
 */
export function resolveEffectiveTarget(
  base: Platform["target"],
  snapshot: DeploymentMeta,
): DeployTarget {
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

export function usesManagedRouting(
  base: Platform["target"],
  effectiveTarget: DeployTarget,
): boolean {
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
    allowHostBuild: !env.CLOUD_MODE,
    cloudAdminProxy: {
      createPage: (input) => cloudClient({ organizationId }).pages.create(input),
      disablePage: (slug) => cloudClient({ organizationId }).pages.disable(slug),
      enablePage: (slug) => cloudClient({ organizationId }).pages.enable(slug),
      deletePage: (slug) => cloudClient({ organizationId }).pages.delete(slug),
    },
  });
}

/**
 * Derive the physical bind namespace from the exact server resolution that also
 * built the platform. Reusing that object is load-bearing: a legacy implicit
 * single-server snapshot must not perform a second mutable server selection for
 * its host-port identity.
 */
function resolveServerHostPortTarget(
  target: ResolvedServerTarget,
): Promise<HostPortTargetIdentity> {
  return resolveHostPortTargetIdentity({
    localHost: target.isLocal,
    serverId: target.id,
    executor: target.executor,
    connection: target.hostPortConnection,
  });
}

/**
 * Resolve one local/server deployment target once and derive every consumer
 * from it: platform, concrete server id, and physical host-port identity.
 */
async function resolveSelfHostedDeploymentTarget(
  target: "local" | "server",
  runtimeMode: RuntimeMode,
  serverId: string | undefined,
  organizationId: string | undefined,
): Promise<Pick<ResolvedDeploymentPlatform, "platform" | "serverId" | "hostPortTarget">> {
  if (target === "local") {
    return {
      platform: await resolveTargetPlatform("local", runtimeMode, undefined, organizationId),
      serverId: null,
      hostPortTarget: LOCAL_HOST_PORT_TARGET,
    };
  }

  const resolvedServer = await resolveServerExecutor(serverId, organizationId);
  return {
    platform: await createPlatformForResolvedServer(resolvedServer, runtimeMode, organizationId),
    serverId: resolvedServer.id,
    hostPortTarget: await resolveServerHostPortTarget(resolvedServer),
  };
}

export async function resolveDeploymentPlatform(
  snapshot: DeploymentMeta,
  opts?: { organizationId?: string; basePlatform?: Platform },
): Promise<ResolvedDeploymentPlatform> {
  const basePlatform = opts?.basePlatform ?? platform();
  const effectiveTarget = resolveEffectiveTarget(basePlatform.target, snapshot);
  const runtimeMode =
    snapshot.runtimeMode ?? (basePlatform.runtime.name === "docker" ? "docker" : "bare");

  if (effectiveTarget === "local" || effectiveTarget === "server") {
    const resolvedTarget = await resolveSelfHostedDeploymentTarget(
      effectiveTarget,
      runtimeMode,
      snapshot.serverId,
      opts?.organizationId,
    );
    return {
      ...resolvedTarget,
      effectiveTarget,
      runtimeMode,
      usesManagedRouting: usesManagedRouting(basePlatform.target, effectiveTarget),
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
    hostPortTarget: null,
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
async function createPlatformForResolvedServer(
  resolved: ResolvedServerTarget,
  runtimeMode: RuntimeMode,
  organizationId?: string,
): Promise<Platform> {
  const resolveRegistryAuth = organizationId ? registryAuthResolver(organizationId) : undefined;
  const { id, executor, isLocal, ssh } = resolved;

  // The auto-registered "This Server" row IS the OpenShip host (VPS /
  // server-host mode): local host executor, host docker socket (DooD),
  // everything on-box.
  if (isLocal) {
    return createPlatform({
      target: "selfhosted",
      runtime: runtimeMode,
      executor,
      localHost: true,
      docker:
        runtimeMode === "docker"
          ? { transport: "socket" as const, resolveRegistryAuth }
          : undefined,
      nginx: resolveAcmeProviderOptions(),
      provisionLock: createProvisionLock("provision:local"),
    });
  }

  return createPlatform({
    target: "selfhosted",
    runtime: runtimeMode,
    executor,
    ssh: ssh!,
    docker:
      runtimeMode === "docker"
        ? { ...toDockerSshTransport(ssh!, executor), resolveRegistryAuth }
        : undefined,
    nginx: resolveAcmeProviderOptions(),
    // Serialize provisioning per target server, so concurrent deploys (across
    // projects / single-app + compose) never race apt/openresty/networks/state.
    provisionLock: createProvisionLock(`provision:server:${id}`),
  });
}

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
    const resolved = await resolveServerExecutor(serverId, organizationId);
    return createPlatformForResolvedServer(resolved, runtimeMode, organizationId);
  }

  // Bind registry credential lookup to the deployment's organization at the
  // platform factory. Every local Docker pull then uses the same tenant-safe
  // resolver as the server helper above.
  const resolveRegistryAuth = organizationId ? registryAuthResolver(organizationId) : undefined;

  // "local" is not a destination anyone picks — it is the ABSENCE of a binding
  // (no cloud workspace, no serverId), so it always means "this box". Nothing
  // offers it: `project.server_id` is ON DELETE SET NULL, so deleting a server is
  // enough to make the next deploy for that project derive it.
  //
  // Which is why it resolves through the SAME executor as the isLocal "This Server"
  // row above. One machine, one path — whether the deploy arrived with that row
  // picked in the wizard or with no binding left at all. Before this, the branch
  // took `createPlatform`'s default `createExecutor()`, a plain local executor: on a
  // compose install that ran every host-side step inside the API CONTAINER, against
  // the wrong filesystem, which is precisely the hazard `createHostExecutor` exists
  // to refuse — reached through a different door. Now a dead channel refuses out
  // loud, with the remedy, and the container workload deploys as before.
  //
  // READ the row, never create it. `findLocalServer` shares its gates with
  // `ensureLocalServer` (self-server.ts), so there is no second definition of "this
  // box's row" to drift from — but registering a server is preparation, not part of
  // resolving a deploy. Calling the ensure here made every deploy on a row-less box
  // responsible for an insert plus the creation path's public-IP lookup (an outbound
  // request), on a function that also runs for plain runtime reads.
  //
  // Only the id is wanted, and only as bookkeeping: null and non-null both resolve to
  // the same pooled host channel below, so a missing row degrades into "no borrow
  // marker", never into a different machine.
  const localRow = await findLocalServer().catch(() => null);
  return createPlatform({
    target: "selfhosted",
    runtime: runtimeMode,
    executor: await acquireLocalHostExecutor(localRow?.id),
    // Explicit, and load-bearing now that an executor is injected: `createPlatform`
    // infers "this machine" from `localHost ?? !executor`, so an injected executor
    // would otherwise read as REMOTE — turning off the containerized edge provider
    // and the same-path-mount rule (`sharedMountExecutor`) for the local box.
    localHost: true,
    docker:
      runtimeMode === "docker" ? { transport: "socket" as const, resolveRegistryAuth } : undefined,
    nginx: resolveAcmeProviderOptions(),
    // Still serialize provisioning: two local deploys share the same host's
    // openresty/docker/state. Same lock name as the isLocal row's branch, because
    // it is the same host being provisioned.
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
  const resolved = await resolveServerExecutor(serverId, organizationId);
  return createDockerRuntimeForResolvedServer(resolved, organizationId);
}

async function createDockerRuntimeForResolvedServer(
  resolved: Pick<Awaited<ReturnType<typeof resolveServerExecutor>>, "executor" | "isLocal" | "ssh">,
  organizationId: string,
): Promise<DockerRuntime> {
  const { executor, isLocal, ssh } = resolved;
  // Registry credentials for every pull this runtime makes, bound to THIS org. Injected
  // rather than read from the host's docker config: it is the only source that works on
  // every install shape, and binding the org here means no later call site can resolve
  // another tenant's login (#581).
  const resolveRegistryAuth = registryAuthResolver(organizationId);
  // isLocal ("This Server") → the host daemon over the local/mounted socket
  // (bare host, or DooD when the API is containerized) — no SSH bridge. Others
  // → dockerode over the pooled SSH connection.
  if (isLocal) {
    return DockerRuntime.create({ transport: "socket", resolveRegistryAuth });
  }
  return DockerRuntime.create({ ...toDockerSshTransport(ssh!, executor), resolveRegistryAuth });
}

/**
 * Executors we handed back REFUSING, and the reason, so the fact travels with the
 * handle instead of in a cache someone has to invalidate (#509).
 *
 * Keyed by the executor object on purpose: a deploy already holds the very executor
 * that was demoted, so identity answers "were host operations available to THIS
 * deploy, on THIS box?" with no key, no TTL, and no way to describe a different
 * target's channel. Entries die with the executor.
 */
const hostChannelRefusals = new WeakMap<CommandExecutor, string>();

/** Last demotion reason we logged, so the decision is logged once per outage and
 *  not once per resolve — see the `console.warn` below. Cleared on recovery. */
let lastLoggedRefusal: string | null = null;

/**
 * One line for a deploy log: host operations were skipped, why, and that the deploy
 * itself is unaffected.
 *
 * Callers emit this ONCE per deploy, before the fan-out. Without it the #509 box does
 * not fail any more — it degrades in silence, because each host touchpoint absorbs the
 * refusal on its own terms: `allocateHostPort` reports an unscanned host (and only
 * under `loopback-port` routing), and the edge/routing step logs "deploy continues".
 * Neither names the channel, so the first legible symptom is a container that dies
 * later over a config file that never landed.
 *
 * Returns null unless this executor is one we demoted — the notice is EVIDENCE, so it
 * is never printed for a target whose channel nothing has decided anything about.
 */
export function hostChannelDeployNotice(executor?: CommandExecutor | null): string | null {
  const reason = executor ? hostChannelRefusals.get(executor) : undefined;
  if (!reason) return null;
  return (
    "Host operations are unavailable on this deploy target, so this deploy skips them: " +
    "live host port-occupancy scans and host-side edge/routing steps. Anything that MUST " +
    "be written on the host — an app template's generated config file — still fails.\n" +
    `${reason}\n${HOST_CHANNEL_UNAFFECTED}`
  );
}

/**
 * This box's host executor, with "this box has no host channel" demoted from a
 * resolve-time throw to a use-time one.
 *
 * `serverId` is the canonical isLocal row when the box has one, and the executor is
 * then POOLED — `sshManager.acquire` hands back the shared host channel, which is what
 * stops one deploy from leaving behind an sshd session (#291). Without a row (desktop,
 * the SaaS, `--no-host-control`) there is nothing to pool against, so the channel is
 * constructed directly. Same box either way, so it must be the same policy: one
 * function, so a target that arrives by the derived `local` door cannot end up with a
 * gentler rule than the one that arrives as a picked server row.
 *
 * A local row's WORKLOAD lives behind the mounted Docker socket; the executor is
 * for host-side extras (static file serve, port scans, host config). So a box with
 * host control off — or containerized with no channel provisioned — should still
 * deploy containers, and only fail on the extras. Before this, `createHostExecutor`
 * throwing at construction meant every deploy to "This Server" died the moment host
 * control was switched off, which is exactly what a blocked-channel banner used to
 * recommend (#490).
 *
 * A channel that is configured but UNREACHABLE arrives here as the same typed error,
 * raised by the manager once it has watched the channel fail — and it is demoted for
 * the same reason. That is not pretending it works: the executor handed back refuses
 * every call with the firewall remedy attached, and the banner and server health both
 * report host control as unavailable. The alternative is what #490 actually did —
 * every container deploy to "This Server" dying on a channel it never needed.
 *
 * The demotion is RECORDED and LOGGED here, because this is where it is decided:
 * before, "this box cannot drive its host" was concluded silently and the operator's
 * first evidence was a symptom several steps downstream (#509). `hostChannelRefusals`
 * carries it forward to the deploy log; the log line covers everything that never
 * reaches a deploy log at all.
 *
 * Any other acquire failure still propagates.
 */
async function acquireLocalHostExecutor(serverId?: string): Promise<CommandExecutor> {
  try {
    // One pooled channel either way — `acquire(localRow)` resolves to the very same
    // executor `acquireHostChannel()` returns, and the row id only adds the borrow
    // marker that lets `probeReachable`/idle cleanup see the row. So the branch is
    // bookkeeping, never a difference in WHICH executor this box gets.
    //
    // The no-row door used to call `createHostExecutor()` here instead, which is a
    // fresh SshExecutor outside the pool, outside the concurrent-acquire dedup and
    // outside the channel-health gate — the unpooled idiom that reached 8,000+
    // orphaned sshd sessions (#291), reintroduced on the one path that has no row to
    // launder through `acquire`. Both doors now take the pooled channel.
    const executor = serverId
      ? await sshManager.acquire(serverId)
      : await sshManager.acquireHostChannel();
    // Recovered — re-arm the log so the NEXT outage is reported rather than deduped
    // against the last one.
    lastLoggedRefusal = null;
    return executor;
  } catch (err) {
    if (!isHostChannelUnavailableError(err)) throw err;
    // Carry the CODE through, not just the prose: the refusal this stands in for is the
    // same fact as the acquire that failed, so a `disabled` channel must not be re-labelled
    // `not_configured` when the refusal is finally raised at use time.
    const executor = unavailableExecutor(err.message, err.code);
    hostChannelRefusals.set(executor, err.message);
    // Once per outage, not per resolve: this sits on every deploy AND on read paths
    // (logs, status polls), so an unconditional line here would bury the log it is
    // meant to be found in. The reason carries the remedy.
    if (lastLoggedRefusal !== err.message) {
      lastLoggedRefusal = err.message;
      console.warn(
        `[host-channel] host operations unavailable on this box (${err.code}). ` +
          `${HOST_CHANNEL_UNAFFECTED} ${err.message}`,
      );
    }
    return executor;
  }
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
  hostPortConnection: HostPortConnectionLocator;
}> {
  const { server, isLocal } = await resolveServerTargetTopology(serverId, organizationId);
  const conn = {
    host: server.sshHost || "127.0.0.1",
    port: server.sshPort ?? 22,
    user: server.sshUser || "root",
  };
  const hostPortConnection: HostPortConnectionLocator = {
    sshHost: server.sshHost,
    sshPort: server.sshPort,
    sshJumpHost: server.sshJumpHost,
    sshArgs: server.sshArgs,
  };
  // isLocal "This Server" OR a row that actually points at THIS host (a plain SSH
  // row for the local box — loopback / SERVER_IP — in the box-owning org). Both
  // resolve to the local host executor + mounted docker socket (DooD); dialing SSH
  // to them hits the API's own loopback (no sshd) — the "Can't reach 127.0.0.1"
  // failure. Org-gated (isLocalHostRow) so a teammate's org can't mint a host-root
  // target from a loopback row.
  if (isLocal) {
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
      executor: await acquireLocalHostExecutor(server.id),
      conn,
      isLocal: true,
      ssh: null,
      hostPortConnection,
    };
  }
  const executor = await sshManager.acquire(server.id);
  const ssh = server.sshHost ? await buildSshConfig(server) : null;
  if (!ssh) {
    throw new Error("Invalid SSH configuration. Check host, auth method, and credentials.");
  }
  return { id: server.id, executor, conn, isLocal: false, ssh, hostPortConnection };
}

/**
 * A server's raw CommandExecutor + SSH endpoint, for the direct
 * server-to-server migration transfer. Thin façade over resolveServerExecutor.
 */
export async function createServerCommandExecutor(
  serverId: string,
  organizationId: string,
): Promise<{
  executor: CommandExecutor;
  conn: { host: string; port: number; user: string };
  isLocal: boolean;
}> {
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
  /** Physical bind namespace used by durable host-port ownership. */
  hostPortTarget: HostPortTargetIdentity | null;
  /** Executor that reaches the same host as `routing` (null on cloud). */
  executor: Platform["executor"];
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
    hostPortTarget: resolved.hostPortTarget,
    executor: resolved.platform.executor,
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
/**
 * Every container an existing deployment owns: its services' containers when it
 * has any, else its own single container.
 *
 * Shared because "the deployment's container" is plural for a compose project and
 * singular everywhere else, and each caller that re-derived it got a different
 * answer — `disableProject` read `deployment.containerId` alone, so pausing a
 * compose project stopped the app and left every sidecar running.
 */
export async function deploymentContainerIds(
  dep: Pick<Deployment, "id" | "containerId">,
): Promise<string[]> {
  // Deliberately NOT error-swallowing: if we can't read the service rows we don't
  // know how many containers this deployment has, and falling back to the single
  // `containerId` would quietly act on one of them.
  const rows = await repos.service.listByDeployment(dep.id);
  const serviceIds = [
    ...new Set(rows.map((r) => r.containerId).filter((id): id is string => !!id)),
  ];
  if (serviceIds.length > 0) return serviceIds;
  // The compose sentinel is a marker, not a container: returning it made a pause
  // report success having stopped nothing (docker 404 → `isAbsent` → swallowed).
  return isRealContainerRef(dep.containerId) ? [dep.containerId] : [];
}

/**
 * Run one container action against a deployment's runtime — THE entry point for
 * every non-deploy runtime operation (enable/disable, restart, logs, info, usage).
 *
 * It exists because each of those call sites used to open its own transport, and
 * each got a different subset of the three things all of them need:
 *
 *   1. the READ resolver, not a full platform. A full platform builds the infra
 *      provider, which runs `detectOpenRestyPaths` plus the edge-Lua self-heal
 *      inside the `provision:local` provision lock — so a status read or a pause
 *      queued behind any in-flight deploy. That is the "the action takes forever"
 *      half of the service-panel timeouts, and the project actions still had it.
 *   2. `dispose()`, always. The SSH branch mints a NEW loopback bridge per
 *      runtime (see docker.ts `watchContainerEvents`), so a call site that
 *      forgets leaks a listening socket plus an ssh client per click — and the
 *      bridge's own accept path warns about exactly the fd pressure that causes.
 *   3. one error classification. A refused key or an unreachable box is not a
 *      client error; mapping it here means every caller reports 503 with the real
 *      cause instead of each inventing a status.
 *
 * For a LONG-LIVED runtime (log streaming, where the transport must outlive this
 * call) use `resolveDeploymentRuntimeForRead` directly and dispose in the
 * stream's cleanup — this helper's whole contract is that the runtime is dead
 * when it returns.
 */
export async function withDeploymentRuntime<T>(
  dep: Pick<Deployment, "meta" | "organizationId">,
  fn: (runtime: RuntimeAdapter, serverId: string | null) => Promise<T>,
): Promise<T> {
  const { runtime, serverId } = await resolveDeploymentRuntimeForRead(dep);
  try {
    return await fn(runtime, serverId);
  } catch (err) {
    throw asHostUnreachable(err);
  } finally {
    disposeRuntime(runtime);
  }
}

/**
 * THE disposal step, so "how do we release a transport" has one answer.
 *
 * Best-effort and non-blocking on purpose: a transport that is already dead can't
 * be closed politely, and a teardown failure must never replace the caller's real
 * error. Optional-called because a bare/cloud runtime has nothing to release —
 * calling it on those is a deliberate no-op, which is what lets every call site
 * dispose unconditionally instead of first asking what kind of runtime it got.
 */
export function disposeRuntime(runtime: RuntimeAdapter | null | undefined): void {
  release(runtime);
}

/** The one place `dispose()` is actually invoked. Structural rather than typed to
 *  `RuntimeAdapter` because the platform loop below releases whichever layers we
 *  decided to release, and those don't share an interface. */
function release(layer: { dispose?: () => Promise<void> } | null | undefined): void {
  if (!layer || ownedByProcessPlatform(layer)) return;
  void Promise.resolve(layer.dispose?.()).catch(() => {});
}

/**
 * Is this layer one the process-wide platform owns, rather than one this resolve built?
 *
 * `resolveDeploymentPlatform` returns `basePlatform` itself — the `getPlatform()` singleton —
 * whenever the effective target is cloud and no org-scoped platform is needed, which on the
 * SaaS (`CLOUD_MODE`) is every such request. `withDeploymentPlatform`'s `finally` then hands
 * the singleton's own layers to `release()`, so one deploy's teardown would dispose the
 * transport every other request in the process is using. It is a no-op today only because a
 * cloud runtime happens to have no `dispose()` — which is precisely the assumption
 * `PLATFORM_DISPOSAL` exists to stop us from making, and it dies the day one gains one.
 *
 * Identity, not a flag: the caller cannot know whether the resolver handed it a fresh
 * platform or the shared one, so asking it to declare ownership reintroduces the bug at
 * fourteen call sites. `peekPlatform` rather than `platform()` because disposal must still
 * work before startup and in unit tests, where "there is no singleton" means "not it".
 */
function ownedByProcessPlatform(layer: object): boolean {
  const shared = peekPlatform();
  if (!shared) return false;
  return (Object.keys(PLATFORM_DISPOSAL) as PlatformDisposableField[]).some(
    (field) => shared[field] === layer,
  );
}

/**
 * Every `Platform` field that CAN be disposed — read off the type, not listed by
 * hand, so a provider that gains a `dispose()` cannot stay invisible here.
 *
 * The probe is `"dispose" extends keyof T` rather than `T extends { dispose?: … }`
 * because an OPTIONAL member is satisfied by every object type: that predicate
 * matches all seven fields and asserts nothing.
 */
type PlatformDisposableField = {
  [K in keyof Platform]-?: "dispose" extends keyof NonNullable<Platform[K]> ? K : never;
}[keyof Platform];

/**
 * Release it, or keep it and say who owns it instead. Total over
 * `PlatformDisposableField`, so a `dispose()` added to `RoutingProvider`,
 * `SslProvider` or `SystemManager` is a missing-key error here (TS2739) rather than
 * a silent leak at all fourteen `disposePlatform` sites — a leak that surfaces as fd
 * exhaustion hours later, nowhere near the resolve that caused it. The union value
 * type is what makes it a decision: you cannot satisfy the key with `undefined`.
 */
const PLATFORM_DISPOSAL: Record<PlatformDisposableField, "release" | { keep: string }> = {
  runtime: "release",
  // NEVER released. `executor` is the pooled per-server SSH executor that
  // `sshManager` owns and that concurrent deploys, routing applies and cert
  // issuance on that box all share — disposing it here would tear the transport out
  // from under every one of them, and the three `.ssl`-only sites in domain-ssl.ts
  // depend on surviving exactly this call. The runtime's Docker-over-SSH bridge is a
  // per-resolve loopback listener, which is why that one is ours to close.
  executor: { keep: "pooled per server by sshManager; shared with concurrent work" },
};

/**
 * `disposeRuntime` for anything that carries a platform. Use in a `finally` on
 * flows too long to wrap in `withDeploymentPlatform`.
 *
 * Takes either shape the resolvers hand back — `resolveTargetPlatform` returns a
 * bare `Platform`, `resolveDeploymentPlatform` wraps it next to the effective target
 * and server id. Both are real and both need releasing, so accepting both beats
 * making ten call sites reach through `.platform`; `Platform` declares no `platform`
 * field, so the narrowing is exact.
 */
export function disposePlatform(
  resolved: Platform | { platform: Platform } | null | undefined,
): void {
  if (!resolved) return;
  const p = "platform" in resolved ? resolved.platform : resolved;
  const decisions = Object.entries(PLATFORM_DISPOSAL) as [
    PlatformDisposableField,
    (typeof PLATFORM_DISPOSAL)[PlatformDisposableField],
  ][];
  for (const [field, decision] of decisions) {
    if (decision === "release") release(p[field]);
  }
}

/**
 * `withDeploymentRuntime`'s twin for the FULL platform — routing + ssl + system
 * alongside the runtime.
 *
 * Separate function rather than a flag because the two have genuinely different
 * costs and the choice must stay visible at the call site: this one builds the
 * infra provider (OpenResty detect + edge-Lua self-heal, under the provision
 * lock), which is right for a route apply and wrong for a status read.
 *
 * The reason it exists at all: `createPlatform` builds its Docker runtime
 * EAGERLY, and an SSH one binds a loopback bridge in the constructor path — so
 * even a caller that only wanted `.routing` and never touches `.runtime` had
 * already bound a listener that only `dispose()` closes.
 */
export async function withDeploymentPlatform<T>(
  dep: Pick<Deployment, "meta" | "organizationId">,
  fn: (resolved: {
    runtime: RuntimeAdapter;
    routing: Platform["routing"];
    ssl: Platform["ssl"];
    executor: Platform["executor"];
    effectiveTarget: DeployTarget;
    serverId: string | null;
    /** Physical TCP bind namespace matching this exact routing/executor target. */
    hostPortTarget: HostPortTargetIdentity | null;
  }) => Promise<T>,
): Promise<T> {
  const resolved = await resolveDeploymentPlatform((dep.meta ?? {}) as DeploymentMeta, {
    organizationId: dep.organizationId,
  });
  try {
    return await fn({
      runtime: resolved.platform.runtime,
      routing: resolved.platform.routing,
      ssl: resolved.platform.ssl,
      executor: resolved.platform.executor,
      effectiveTarget: resolved.effectiveTarget,
      serverId: resolved.serverId,
      hostPortTarget: resolved.hostPortTarget,
    });
  } catch (err) {
    throw asHostUnreachable(err);
  } finally {
    disposePlatform(resolved);
  }
}

/**
 * Re-label "we could not reach the host" as a 503 `HostUnreachableError`, keeping
 * the underlying message (which already names the target and the fix — see
 * ssh-support.ts). Anything else passes through untouched.
 *
 * The distinction is the whole point: a 400 tells the operator they sent a bad
 * request, when in fact their request was fine and the server was not.
 */
function asHostUnreachable(err: unknown): unknown {
  if (err instanceof HostUnreachableError) return err;
  // isConnectionLoss, not the raw adapter predicate: lib/remote-state.ts is this
  // app's one present/absent/unreachable classifier, and it additionally catches
  // the executor's lowercase command-timeout string.
  if (isHostChannelUnavailableError(err) || isConnectionLoss(err)) {
    return new HostUnreachableError(safeErrorMessage(err));
  }
  return err;
}

export async function resolveDeploymentRuntimeForRead(
  dep: Pick<Deployment, "meta" | "organizationId">,
): Promise<{
  runtime: RuntimeAdapter;
  serverId: string | null;
  hostPortTarget: HostPortTargetIdentity | null;
}> {
  // Services are containers even when the app itself deploys "bare" — pin docker
  // so a bare project's sidecars still resolve a docker runtime (matches
  // resolveServicePlatform's long-standing behaviour).
  const snapshot = { ...((dep.meta ?? {}) as DeploymentMeta), runtimeMode: "docker" as const };
  const effectiveTarget = resolveEffectiveTarget(platform().target, snapshot);

  if (effectiveTarget === "server") {
    const target = await resolveServerExecutor(snapshot.serverId, dep.organizationId);
    return {
      runtime: await createDockerRuntimeForResolvedServer(target, dep.organizationId),
      // The concrete id selected by the same org-scoped resolution that built
      // the transport; legacy implicit-single-server snapshots must not report
      // null or resolve a different row on a second lookup.
      serverId: target.id,
      hostPortTarget: await resolveServerHostPortTarget(target),
    };
  }
  if (effectiveTarget === "local") {
    return {
      runtime: await DockerRuntime.create({ transport: "socket" }),
      serverId: null,
      hostPortTarget: LOCAL_HOST_PORT_TARGET,
    };
  }
  const resolved = await resolveDeploymentPlatform(snapshot, {
    organizationId: dep.organizationId,
  });
  return {
    runtime: resolved.platform.runtime,
    serverId: resolved.serverId,
    hostPortTarget: resolved.hostPortTarget,
  };
}
