/** Retained server diagnostics and component installers behind shared authorization. */
import { OperationError, type CreateServerInput, type ServerOperations } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import type { ServerDependencies } from "../../../servers";
import { env } from "../../config";
import {
  checkComponents, needsDockerGroupRefresh, type CommandExecutor, COMPONENT_INSTALLERS, COMPONENT_UNINSTALLERS,
  getRemovalSupport, invalidateHostChannelAuth, isHostChannelUnavailableError, isSshAuthError,
  scanPorts, type SystemLog, SYSTEM_COMPONENTS, REMOTE_SERVER_REQUIRED_COMPONENTS, resolveSystemComponentInstallPlan,
} from "@repo/adapters";
import { confirmPortScanReachability } from "../../lib/port-reachability";
import { formatDuration, systemDebug } from "../../lib/system-debug";
import { sshManager, buildSshConfig, isTransportFailure } from "../../lib/ssh-manager";
import { sshKeyPathProblem } from "../../lib/ssh-key-path";
import { pinnedEdgeImage, withPinnedEdgeImage } from "../../lib/edge-image";
import { deliverManagedImage } from "../../lib/deliver-managed-image";
import { runConnectivityCheck } from "../../lib/connectivity";
import "../../lib/connectivity-checks";
import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { assertNativeSshSettings, assertServerExecution, requireSelfHostedServer } from "./server-access";

export const ALLOWED_COMPONENTS = new Set(SYSTEM_COMPONENTS.filter(component => component.installable).map(component => component.name));
const REMOVABLE_COMPONENTS = new Set(Object.keys(COMPONENT_UNINSTALLERS));

export function failSystem(details: Record<string, unknown>, status: number): never {
  throw new OperationError(String(details.error ?? details.message ?? "System operation failed"), status,
    typeof details.code === "string" ? details.code : typeof details.error === "string" ? details.error : "SERVER_CHECK_FAILED", details);
}


async function withCapabilities<T extends { name: string; installed?: boolean }>(
  executor: CommandExecutor,
  components: T[],
): Promise<Array<T & { removable: boolean; removeSupported?: boolean; removeBlockedReason?: string }>> {
  return Promise.all(
    components.map(async (component) => {
      const removable = REMOVABLE_COMPONENTS.has(component.name);
      if (!removable || !component.installed) {
        return {
          ...component,
          removable,
        };
      }

      const support = await getRemovalSupport(executor, component.name);
      return {
        ...component,
        removable,
        removeSupported: support.supported,
        removeBlockedReason: support.reason,
      };
    }),
  );
}


/**
 * Infrastructure components - optional but important for app deployment.
 * Shown in System Health only when detected (installed) on the server.
 */
function resolveInfraComponents(): string[] {
  return SYSTEM_COMPONENTS
    .filter((c) => c.category === "infrastructure")
    .map((c) => c.name);
}

async function checkServerComponents(serverId: string, names: string[]) {
  return sshManager.withExecutor(serverId, async (executor) => {
    const components = await checkComponents(executor, names);
    if (await needsDockerGroupRefresh(executor, components)) {
      const fresh = await sshManager.refreshAuthentication(serverId, executor);
      if (fresh !== executor) {
        // Recheck once through the updated pool so health and subsequent server
        // operations use the same authenticated session and group membership.
        return sshManager.withExecutor(serverId, async (next) =>
          withCapabilities(next, await checkComponents(next, names)),
        );
      }
      const docker = components.find((component) => component.name === "docker")!;
      docker.message += " Restart Openship to apply the updated user group membership.";
    }
    return withCapabilities(executor, components);
  });
}


// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * POST /system/test-connection
 *
 * Test an SSH connection using credentials from the request body
 * **without** persisting them to the database. Used by the server
 * form to validate before saving.
 *
 * Body: { sshHost, sshPort?, sshUser?, sshAuthMethod, sshPassword?, sshKeyPath?,
 *         sshPrivateKey?, sshKeyPassphrase?, sshJumpHost?, sshArgs? }
 * Returns: { ok: boolean, message: string, code?: ConnectivityCode }
 *
 * `sshJumpHost`/`sshArgs` are not optional decoration: a host only reachable
 * through a bastion must be PROBED through it, or the test contradicts the save.
 * The dashboard's `SshProbeInput` is this list.
 */
/**
 * Run an ephemeral SSH echo test from request-body credentials (no DB row).
 * Shared by the authenticated `/test-connection` and the pre-auth first-run
 * `/onboarding/test-connection` so both behave identically.
 */
export async function runEphemeralConnectionTest(body: CreateServerInput) {
  const startedAt = Date.now();
  const built = await buildEphemeralSshConfig(body);

  systemDebug("system-check", `test-connection:start`);
  const result = await runConnectivityCheck("ssh", built);
  systemDebug(
    "system-check",
    `test-connection:done ok=${result.ok} code=${result.code} (${formatDuration(startedAt)})`,
  );

  // Preserve the historical HTTP contract (bad creds → 400, other failures →
  // 502) and the friendly auth copy; `code` is additive for richer client UI.
  const message =
    result.code === "auth_failed"
      ? "Authentication failed - check your credentials"
      : result.message;
  return { ok: result.ok, message, code: result.code };
}


export async function testConnection(ctx: ExecutionContext, body: CreateServerInput) {
  if (env.CLOUD_MODE) return failSystem({ error: "Not available" }, 404);

  // Gate to org owner/admin: this endpoint connects to an arbitrary SSH host
  // from the request body (onboarding/setup wizard flow). Even non-Hono
  // permission paths don't apply here — there's no DB resource yet. We
  // simply require the caller be an org admin+ to mitigate SSRF / port-scan
  // oracles by unprivileged members. Private IPs are NOT blocked because
  // admins may legitimately test internal hosts.
  const m = await repos.member.find(ctx.organizationId, ctx.userId);
  if (!m || (m.role !== "owner" && m.role !== "admin")) {
    return failSystem({ error: "Insufficient permissions" }, 403);
  }

  const result = await runEphemeralConnectionTest(body);
  if (result.ok) audit.recordAsync(operationAuditContext(ctx), { eventType: "server:write", resourceType: "server", resourceId: "*" });
  return result;
}


/**
 * Build an ephemeral SshConfig from request-body credentials for a one-off
 * connectivity check. Returns the config, or a Response when validation fails.
 */
async function buildEphemeralSshConfig(body: CreateServerInput) {
  const host = (body.sshHost as string)?.trim();
  if (!host) {
    return failSystem({ ok: false, message: "SSH host is required" }, 400);
  }

  // Diagnose the key path BEFORE buildSshConfig, which folds every key failure
  // into a null return that reads as "Invalid auth configuration". This route
  // exists to tell the operator what's wrong, and "wrong" here is usually
  // concrete: a relative path, a key that was never copied to THIS host, or one
  // outside the allowlisted roots (the desktop file picker can reach those).
  assertNativeSshSettings(body);
  const rawKeyPath = typeof body.sshKeyPath === "string" ? body.sshKeyPath.trim() : "";
  const rawKeyMaterial = typeof body.sshPrivateKey === "string" ? body.sshPrivateKey.trim() : "";
  if (body.sshAuthMethod === "key") {
    // Pasted/uploaded material lives in the request, not on this host — no path
    // to diagnose. Only fall back to the path diagnostic when no key was pasted.
    if (!rawKeyMaterial && rawKeyPath) {
      const problem = sshKeyPathProblem(rawKeyPath);
      if (problem) {
        return failSystem({ ok: false, message: problem, code: "key_path_invalid" }, 400);
      }
    } else if (!rawKeyMaterial && !rawKeyPath) {
      return failSystem({ ok: false, message: "Paste a private key or provide a key path", code: "key_missing" }, 400);
    }
  }

  // buildSshConfig also handles "agent" auth (uses the host's SSH_AUTH_SOCK,
  // like VSCode) and THROWS a clear message when agent is selected but no
  // agent is available — surface that as a clean 400 instead of a 500.
  let config;
  try {
    config = await buildSshConfig({
      sshHost: host,
      sshPort: body.sshPort ? Number(body.sshPort) : null,
      sshUser: (body.sshUser as string) || null,
      sshAuthMethod: body.sshAuthMethod as string,
      sshPassword: body.sshPassword as string ?? null,
      sshKeyPath: body.sshKeyPath as string ?? null,
      sshPrivateKey: body.sshPrivateKey as string ?? null,
      sshKeyPassphrase: body.sshKeyPassphrase as string ?? null,
      sshJumpHost: body.sshJumpHost as string ?? null,
      sshTransport: body.sshTransport,
      sshArgs: body.sshArgs as string ?? null,
    });
  } catch (err) {
    if (err instanceof OperationError) throw err;
    return failSystem({ ok: false, message: safeErrorMessage(err) }, 400);
  }

  if (!config) {
    return failSystem({ ok: false, message: "Invalid auth configuration" }, 400);
  }

  return config;
}


/**
 * POST /system/check
 *
 * Run system health checks against a specific server.
 * Body: { serverId: string, components?: ["docker", "git"] }
 *
 * Returns: { components: ComponentStatus[], ready: boolean, missing: string[] }
 */
export async function checkServer(ctx: ExecutionContext, serverId: string, body: Parameters<ServerOperations["check"]>[1] = {}) {
  if (env.CLOUD_MODE) return failSystem({ error: "Not available" }, 404);

  const startedAt = Date.now();


  // OUTSIDE the try, and that is the point: `permission.assert` throws NotFoundError
  // for a row the caller may not see, which the error handler turns into a 404. Caught
  // here it fell through to the connection diagnosis below and answered 502 with the
  // host channel's real address and remedy — an unauthorized caller learning the
  // endpoint from a permission failure.
  

  // Same reasoning, smaller stakes: a rejected component list is a 400 about the
  // request, not a connection failure, so it must not reach the catch either. Which
  // also means it can no longer be a non-array that throws on `.filter` and lands as
  // a 502 about a healthy server.
  const requestedComponents = body.components;
  if (requestedComponents !== undefined && !Array.isArray(requestedComponents)) {
    return failSystem({ error: "components must be an array" }, 400);
  }
  const valid: string[] | null = requestedComponents?.length
    ? (requestedComponents as string[]).filter((n) => ALLOWED_COMPONENTS.has(n))
    : null;
  if (valid && valid.length === 0) {
    return failSystem({ error: "Invalid component names" }, 400);
  }

  await assertServerExecution(await requireSelfHostedServer(ctx, serverId));
  try {
    systemDebug("system-check",
      `check:start server=${serverId} ${valid?.length ? valid.join(",") : "all"}`,
    );

    let components;
    if (valid) {
      components = await checkServerComponents(serverId, valid);
    } else {
      // Check core required + all infrastructure components
      // Remote requirements come from the shared system policy. DEPLOY_MODE is
      // how this control plane runs, not what this target server needs.
      const required = [...REMOTE_SERVER_REQUIRED_COMPONENTS];
      const infra = resolveInfraComponents();
      const requiredSet = new Set<string>(required);
      const allToCheck = [...required, ...infra.filter((n) => !requiredSet.has(n))];

      const allResults = await checkServerComponents(serverId, allToCheck);

      // Required components always shown; infra only shown when installed
      components = allResults
        .map((c) => ({
          ...c,
          optional: !requiredSet.has(c.name),
        }))
        .filter((c) => !c.optional || c.installed);
    }

    // "missing" and "ready" only consider required (non-optional) components
    const missing = components
      .filter((c) => !c.healthy && !c.optional)
      .map((c) => c.name);

    systemDebug("system-check", 
      `check:done ready=${missing.length === 0} missing=${missing.join(",") || "none"} (${formatDuration(startedAt)})`,
    );
    return {
      components,
      ready: missing.length === 0,
      missing,
    };
  } catch (err) {
    if (err instanceof OperationError) throw err;
    const message =
      err instanceof Error ? err.message : "Failed to connect to server";
    systemDebug("system-check", `check:failed ${message} (${formatDuration(startedAt)})`);
    if (
      message === "No server configured" ||
      message === "Invalid SSH auth configuration"
    ) {
      return failSystem({ error: "no_server", message }, 400);
    }
    // A connect failure on THIS box is almost never "the server is down" — it's the
    // container→host SSH channel, and the row's display sshHost (127.0.0.1) names
    // neither the right machine nor the right port (#490). Hand the UI the address
    // we actually dial plus the remedy, so the banner stops pointing at loopback.
    //
    // Only for failures that came from the transport: a component check that threw for
    // its own reasons is not evidence about the channel, and diagnosing it anyway costs
    // a TCP probe to tell the operator about a firewall that was never involved.
    //
    // #527 added `isSshAuthError` here and moved the generic `auth_failed` answer BELOW
    // this block. An auth rejection on the local row was being claimed by that branch
    // before this one could run, and on that row the answer is always wrong: its stored
    // credentials are display-only, nothing dials with them, so the operator got an
    // edit-credentials form that could not change the outcome. Reordering is safe for
    // remote servers because `host_channel_blocked` only ever comes back for a row that
    // resolves to THIS box — a remote box with a genuinely rejected key still falls
    // through to `auth_failed`.
    if (isSshAuthError(err) || isHostChannelUnavailableError(err) || isTransportFailure(err)) {
      // A rejection we are HOLDING beats a memoized "the key worked 20s ago". Without
      // this, a health probe that cached success just before the key stopped working
      // would answer `ok`, the diagnosis would not name the channel, and the failure
      // would fall through to the generic credentials answer this branch exists to
      // prevent — the #527 card, restored by a cache.
      if (isSshAuthError(err)) invalidateHostChannelAuth();
      const d = await sshManager.diagnoseReachability(serverId).catch(() => null);
      if (d?.code === "host_channel_blocked") {
        return failSystem({
            error: "host_channel_blocked",
            code: "host_channel_blocked",
            message,
            target: d.target ?? null,
            hint: d.hint ?? null,
            rule: d.rule ?? null,
            // Which state this is. `host_channel_blocked` is one verdict over several
            // states whose remedies differ, and the banner has to pick copy per state
            // rather than infer it from which fields happen to be null (#509).
            channel: d.channel ?? null,
          }, 502);
      }
    }
    // Reached only when the diagnosis did NOT name the host channel — i.e. a real remote
    // server whose key or password the far end refused, which is what this answer is for.
    if (isSshAuthError(err)) {
      return failSystem({ error: "auth_failed", message }, 400);
    }
    return failSystem({ error: "connection_failed", message }, 502);
  }
}


/**
 * Edge-only Stage-B APPLY ahead of a component installer: build our source onto the
 * box (or ship + build for a remote one) so the create path adopts the dev image
 * instead of pulling an unpublished dev tag from GHCR (the reported bug). A no-op for
 * every non-edge component (docker/git/rsync aren't our images) and in prod (no
 * checkout → deliver returns at once). Shared by the two install entry points below so
 * the edge gate and the deliver call can't drift between them.
 */
export async function deliverEdgeBeforeInstall(
  component: string,
  executor: CommandExecutor,
  onLog: (log: SystemLog) => void,
): Promise<void> {
  if (component !== "edge") return;
  await deliverManagedImage({
    kind: "edge",
    image: pinnedEdgeImage(),
    targetExecutor: executor,
    onLog,
  });
}


/** All transitive prerequisites, in install order, excluding the component. */
export function installPrerequisites(component: string): string[] {
  return resolveSystemComponentInstallPlan([component]).filter((name) => name !== component);
}


/** Read-only dependency gate shared by both install endpoints. */
async function missingInstallPrerequisites(
  executor: CommandExecutor,
  component: string,
): Promise<string[]> {
  const prerequisites = installPrerequisites(component);
  if (prerequisites.length === 0) return [];

  const statuses = await checkComponents(executor, prerequisites);
  const healthy = new Set(statuses.filter((status) => status.healthy).map((status) => status.name));
  return prerequisites.filter((name) => !healthy.has(name));
}


export function dependencyFailureMessage(component: string, missing: string[]): string {
  return `${component} requires healthy ${missing.join(", ")} on this server. Install ${missing.join(", ")} first.`;
}


/**
 * POST /system/install
 *
 * Install a specific component on a server.
 * Body: { serverId: string, component: "docker" | "edge" | ..., config?: InstallerConfig }
 *
 * Returns: { success: boolean, component: string, version?: string, error?: string }
 */
export async function installComponent(ctx: ExecutionContext, serverId: string, body: Parameters<ServerOperations["installComponent"]>[1]) {
  if (env.CLOUD_MODE) return failSystem({ error: "Not available" }, 404);


  

  const componentName = body.component as string;

  if (!componentName || !ALLOWED_COMPONENTS.has(componentName)) {
    return failSystem({ error: "Invalid or missing component name" }, 400);
  }

  const installerFn =
    COMPONENT_INSTALLERS[componentName as keyof typeof COMPONENT_INSTALLERS];
  if (!installerFn) {
    return failSystem({ error: `No installer for ${componentName}` }, 400);
  }

  // Hoisted so the catch can return whatever the build/install already logged: a
  // from-source edge build that fails throws with its output ONLY in these lines, and
  // a success-only `logs` would drop exactly the diagnostic the operator needs.
  const logs: string[] = [];
  await assertServerExecution(await requireSelfHostedServer(ctx, serverId));
  try {
    const outcome = await sshManager.withExecutor(serverId, async (executor) => {
      // This gate must run before deliverEdgeBeforeInstall: in development that
      // delivery builds the Edge image on the target and therefore needs Docker
      // itself. The adapter installer keeps its own guard for non-API callers.
      const missingDependencies = await missingInstallPrerequisites(executor, componentName);
      if (missingDependencies.length > 0) return { missingDependencies } as const;

      await deliverEdgeBeforeInstall(componentName, executor, (log) => logs.push(log.message));
      const installResult = await installerFn(
        executor,
        (log) => logs.push(log.message),
        withPinnedEdgeImage(body.config ?? {}),
      );
      return { installResult } as const;
    });

    if ("missingDependencies" in outcome && outcome.missingDependencies) {
      const missingDependencies = outcome.missingDependencies;
      return failSystem({
          error: "missing_dependency",
          component: componentName,
          missing: missingDependencies,
          message: dependencyFailureMessage(componentName, missingDependencies),
          logs,
        }, 409);
    }

    return {
      ...outcome.installResult,
      logs,
    };
  } catch (err) {
    if (err instanceof OperationError) throw err;
    const message =
      err instanceof Error ? err.message : "Installation failed";
    if (
      message === "No server configured" ||
      message === "Invalid SSH auth configuration"
    ) {
      return failSystem({ error: "no_server", message, logs }, 400);
    }
    if (isSshAuthError(err)) {
      return failSystem({ error: "auth_failed", message, logs }, 400);
    }
    return failSystem({ error: "install_failed", message, logs }, 502);
  }
}


/**
 * POST /system/remove
 *
 * Remove a specific component from a server.
 * Body: { serverId: string, component: "edge" | "rsync" }
 *
 * Returns: { success: boolean, component: string, error?: string, logs?: string[] }
 */
export async function removeComponent(ctx: ExecutionContext, serverId: string, body: Parameters<ServerOperations["removeComponent"]>[1]) {
  if (env.CLOUD_MODE) return failSystem({ error: "Not available" }, 404);


  

  const componentName = body.component as string;
  if (!componentName || !REMOVABLE_COMPONENTS.has(componentName)) {
    return failSystem({ error: "Invalid or unsupported component name" }, 400);
  }

  const uninstallerFn = COMPONENT_UNINSTALLERS[componentName as keyof typeof COMPONENT_UNINSTALLERS];
  if (!uninstallerFn) {
    return failSystem({ error: `No remover for ${componentName}` }, 400);
  }

  await assertServerExecution(await requireSelfHostedServer(ctx, serverId));
  try {
    const logs: string[] = [];
    const result = await sshManager.withExecutor(serverId, (executor) =>
      uninstallerFn(
        executor,
        (log) => logs.push(log.message),
        withPinnedEdgeImage(body.config ?? {}),
      ),
    );

    return {
      ...result,
      logs,
    };
  } catch (err) {
    if (err instanceof OperationError) throw err;
    const message = err instanceof Error ? err.message : "Removal failed";
    if (
      message === "No server configured" ||
      message === "Invalid SSH auth configuration"
    ) {
      return failSystem({ error: "no_server", message }, 400);
    }
    if (isSshAuthError(err)) {
      return failSystem({ error: "auth_failed", message }, 400);
    }
    return failSystem({ error: "remove_failed", message }, 502);
  }
}


/**
 * POST /system/servers/:id/ports/scan
 *
 * Enumerate every listening socket on the server and classify each exposed
 * (bound to a wildcard / real interface) vs loopback-only. Read-only.
 *
 * Runs through the shared executor middleware (`sshManager.withExecutor`) so the
 * socket table is read INSIDE the target — the API itself may be containerized
 * and only sees the host's real ports via that server's executor, not a direct
 * exec. A `probeReachable` fast-fail keeps an offline box from hanging the tab
 * on the full SSH-connect timeout.
 */
export async function scanExposedPorts(ctx: ExecutionContext, serverId: string) {
  if (env.CLOUD_MODE) return failSystem({ error: "Not available" }, 404);

  const organizationId = ctx.organizationId;
  

  const server = await repos.server.getInOrganization(serverId, organizationId);
  if (!server) return failSystem({ error: "Server not found" }, 404);

  await assertServerExecution(server);
  const reachable = await sshManager.probeReachable(serverId).catch(() => false);
  if (!reachable) {
    return failSystem({ error: "unreachable", message: "Server is not reachable over SSH right now." }, 502);
  }

  try {
    const result = await sshManager.withExecutor(serverId, (executor) => scanPorts(executor));
    const enriched = await confirmPortScanReachability(result, server.sshHost);
    return enriched;
  } catch (err) {
    if (err instanceof OperationError) throw err;
    const message = safeErrorMessage(err);
    if (isSshAuthError(err)) return failSystem({ error: "auth_failed", message }, 400);
    return failSystem({ error: "scan_failed", message }, 502);
  }
}
export const serverCheckResources: Pick<ServerDependencies["resources"], "check" | "installComponent" | "removeComponent" | "scanPorts"> = {
  async check(ctx, id, input) {
    const result = await checkServer(ctx, id, input);
    audit.recordAsync(operationAuditContext(ctx), { eventType: "server:admin", resourceType: "server", resourceId: id });
    return result;
  },
  scanPorts: scanExposedPorts,
  async installComponent(ctx, id, input) {
    const result = await installComponent(ctx, id, input);
    audit.recordAsync(operationAuditContext(ctx), { eventType: "server:admin", resourceType: "server", resourceId: id });
    return result;
  },
  async removeComponent(ctx, id, input) {
    const result = await removeComponent(ctx, id, input);
    audit.recordAsync(operationAuditContext(ctx), { eventType: "server:admin", resourceType: "server", resourceId: id });
    return result;
  },
};
