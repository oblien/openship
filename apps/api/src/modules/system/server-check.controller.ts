/**
 * Server check & install controller - runs system health checks and
 * component installation against the configured remote server.
 *
 * Uses the shared SSH connection manager so all server interactions go
 * through one cached executor handler with idle TTL + optional
 * persistent mode.
 *
 * Security:
 *   - Gated behind localOnly + authMiddleware (no cloud, no unauthenticated)
 *   - SSH credentials are read from DB, never from request body
 *   - Component names are validated against a known allowlist
 */

import type { Context } from "hono";
import { streamSSE } from "../../lib/sse";
import { env } from "../../config";
import {
  checkComponents,
  type CommandExecutor,
  COMPONENT_INSTALLERS,
  COMPONENT_UNINSTALLERS,
  ensureEdge,
  getRemovalSupport,
  isSshAuthError,
  recoverInterruptedTakeover,
  scanPorts,
  probeTcp,
  type PortScanResult,
  SYSTEM_COMPONENTS,
  getSystemComponentDefinition,
} from "@repo/adapters";
import { formatDuration, systemDebug } from "@/lib/system-debug";
import { sshManager, buildSshConfig } from "../../lib/ssh-manager";
import { runConnectivityCheck } from "../../lib/connectivity";
import "../../lib/connectivity-checks"; // registers ssh / ssh-server / backup-destination
import { repos } from "@repo/db";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { safeErrorMessage } from "@repo/core";
import {
  createSetupSession,
  getSetupSession,
  getActiveSetupSession,
  updateComponentProgress,
  appendSetupLog,
  finishSetupSession,
  subscribeSetupSession,
  promptSetupUser,
  respondToSetupPrompt,
  rejectPendingSetupPrompt,
  setupPromptState,
} from "./setup-session";
import type { PromptUserFn } from "@repo/adapters";

// ─── Allowlisted components ──────────────────────────────────────────────────

const ALLOWED_COMPONENTS = new Set(
  SYSTEM_COMPONENTS.filter((component) => component.installable).map(
    (component) => component.name,
  ),
);

const REMOVABLE_COMPONENTS = new Set(Object.keys(COMPONENT_UNINSTALLERS));

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
 * Core components required for the current deployment mode.
 * These are always shown in System Health regardless of install state.
 */
function resolveRequiredComponents(): string[] {
  const mode = env.DEPLOY_MODE;
  if (mode === "docker") return ["docker", "git"];
  if (mode === "bare") return ["git"];
  return ["git"];
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

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * POST /system/test-connection
 *
 * Test an SSH connection using credentials from the request body
 * **without** persisting them to the database. Used by the server
 * form to validate before saving.
 *
 * Body: { sshHost, sshPort?, sshUser?, sshAuthMethod, sshPassword?, sshKeyPath?, sshKeyPassphrase? }
 * Returns: { ok: boolean, message: string }
 */
/**
 * Run an ephemeral SSH echo test from request-body credentials (no DB row).
 * Shared by the authenticated `/test-connection` and the pre-auth first-run
 * `/onboarding/test-connection` so both behave identically.
 */
async function runEphemeralConnectionTest(c: Context): Promise<Response> {
  const startedAt = Date.now();
  const built = await buildEphemeralSshConfig(c);
  if (built instanceof Response) return built; // validation error already sent

  systemDebug("system-check", `test-connection:start`);
  const result = await runConnectivityCheck("ssh", built);
  systemDebug(
    "system-check",
    `test-connection:done ok=${result.ok} code=${result.code} (${formatDuration(startedAt)})`,
  );

  // Preserve the historical HTTP contract (bad creds → 400, other failures →
  // 502) and the friendly auth copy; `code` is additive for richer client UI.
  const status = result.ok ? 200 : result.code === "auth_failed" ? 400 : 502;
  const message =
    result.code === "auth_failed"
      ? "Authentication failed - check your credentials"
      : result.message;
  return c.json({ ok: result.ok, message, code: result.code }, status);
}

export async function testConnection(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  // Gate to org owner/admin: this endpoint connects to an arbitrary SSH host
  // from the request body (onboarding/setup wizard flow). Even non-Hono
  // permission paths don't apply here — there's no DB resource yet. We
  // simply require the caller be an org admin+ to mitigate SSRF / port-scan
  // oracles by unprivileged members. Private IPs are NOT blocked because
  // admins may legitimately test internal hosts.
  const ctx = getRequestContext(c);
  const m = await repos.member.find(ctx.organizationId, ctx.userId);
  if (!m || (m.role !== "owner" && m.role !== "admin")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  return runEphemeralConnectionTest(c);
}

/**
 * POST /system/onboarding/test-connection
 *
 * Pre-auth, first-run-only counterpart to `/test-connection`. During onboarding
 * no user/session exists yet (mirrors the public `/system/onboarding` setup
 * route), so instead of an org-role gate we only allow it while the instance
 * has no servers configured. Same ephemeral SSH echo test, no persistence.
 */
export async function onboardingTestConnection(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  // A publicly-served / CLI-managed instance is network-reachable, so an
  // UNauthenticated SSH prober here is an SSRF / port-scan oracle. Those
  // instances must be configured through the authenticated flow — disable the
  // pre-auth variant for them entirely.
  if (env.OPENSHIP_PUBLIC_URL || env.OPENSHIP_REQUIRE_AUTH) {
    return c.json({ error: "Not available" }, 404);
  }

  const servers = await repos.server.list();
  if (servers.length > 0) {
    return c.json({ error: "Instance already configured" }, 403);
  }

  // Never let the pre-auth prober reach loopback / link-local / cloud-metadata
  // targets — never a legitimate remote SSH server, and the highest-value SSRF
  // targets (e.g. 169.254.169.254). Private LAN ranges stay allowed (real
  // self-hosted servers live there). Hostname→internal-IP rebinding is a known
  // residual that needs the onboarding auth model to fully close.
  const body = await c.req.json().catch(() => ({}));
  if (isBlockedSshTarget(typeof body?.sshHost === "string" ? body.sshHost.trim() : "")) {
    return c.json({ ok: false, message: "This host is not allowed.", code: "blocked_host" }, 400);
  }

  return runEphemeralConnectionTest(c);
}

/** Literal loopback / link-local / cloud-metadata / wildcard SSH targets. */
function isBlockedSshTarget(host: string): boolean {
  if (!host) return false; // empties handled by the normal validation
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "ip6-localhost") return true;
  if (h === "0.0.0.0" || h === "::" || h === "::1") return true;
  if (/^127\./.test(h)) return true; // IPv4 loopback
  if (/^169\.254\./.test(h)) return true; // IPv4 link-local + cloud metadata
  if (/^(fe80|fc|fd)/.test(h)) return true; // IPv6 link-local / ULA
  return false;
}

/**
 * Build an ephemeral SshConfig from request-body credentials for a one-off
 * connectivity check. Returns the config, or a Response when validation fails.
 */
async function buildEphemeralSshConfig(c: Context) {
  const body = await c.req.json().catch(() => ({}));
  const host = (body.sshHost as string)?.trim();
  if (!host) {
    return c.json({ ok: false, message: "SSH host is required" }, 400);
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
      sshKeyPassphrase: body.sshKeyPassphrase as string ?? null,
      sshJumpHost: body.sshJumpHost as string ?? null,
      sshArgs: body.sshArgs as string ?? null,
    });
  } catch (err) {
    return c.json({ ok: false, message: safeErrorMessage(err) }, 400);
  }

  if (!config) {
    return c.json({ ok: false, message: "Invalid auth configuration" }, 400);
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
export async function checkServer(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const startedAt = Date.now();

  try {
    const body = await c.req.json().catch(() => ({}));
    const serverId = body.serverId as string | undefined;
    if (!serverId) return c.json({ error: "serverId is required" }, 400);

    getRequestContext(c);
    await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: serverId, action: "admin" });

    const requestedComponents = body.components as string[] | undefined;
    systemDebug("system-check", 
      `check:start server=${serverId} ${requestedComponents?.length ? requestedComponents.join(",") : "all"}`,
    );

    let components;
    if (requestedComponents?.length) {
      // Validate against allowlist
      const valid = requestedComponents.filter((n) => ALLOWED_COMPONENTS.has(n));
      if (valid.length === 0) {
        return c.json({ error: "Invalid component names" }, 400);
      }
      components = await sshManager.withExecutor(serverId, async (executor) =>
        withCapabilities(executor, await checkComponents(executor, valid)),
      );
    } else {
      // Check core required + all infrastructure components
      const required = resolveRequiredComponents();
      const infra = resolveInfraComponents();
      const requiredSet = new Set(required);
      const allToCheck = [...required, ...infra.filter((n) => !requiredSet.has(n))];

      const allResults = await sshManager.withExecutor(serverId, async (executor) =>
        withCapabilities(executor, await checkComponents(executor, allToCheck)),
      );

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
    return c.json({
      components,
      ready: missing.length === 0,
      missing,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to connect to server";
    systemDebug("system-check", `check:failed ${message} (${formatDuration(startedAt)})`);
    if (
      message === "No server configured" ||
      message === "Invalid SSH auth configuration"
    ) {
      return c.json({ error: "no_server", message }, 400);
    }
    if (isSshAuthError(err)) {
      return c.json({ error: "auth_failed", message }, 400);
    }
    return c.json({ error: "connection_failed", message }, 502);
  }
}

/**
 * POST /system/install/respond
 *
 * Answer a prompt raised mid-install (e.g. the OpenResty edge-takeover hold).
 * Body: { action: string, sessionId?: string }. Targets the active session
 * when no sessionId is given (only one install runs at a time).
 */
export async function installRespond(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const action = body.action as string | undefined;
  if (!action) return c.json({ error: "action is required" }, 400);

  const sessionId = (body.sessionId as string | undefined) ?? getActiveSetupSession()?.id;
  if (!sessionId) return c.json({ error: "no_active_session" }, 404);

  const session = getSetupSession(sessionId);
  if (!session) return c.json({ error: "no_active_session" }, 404);

  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: session.serverId, action: "admin" });

  const resolved = respondToSetupPrompt(sessionId, action);
  if (!resolved) return c.json({ error: "no_pending_prompt" }, 409);
  return c.json({ ok: true });
}

/**
 * POST /system/install
 *
 * Install a specific component on a server.
 * Body: { serverId: string, component: "docker" | "openresty" | ..., config?: InstallerConfig }
 *
 * Returns: { success: boolean, component: string, version?: string, error?: string }
 */
export async function installComponent(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const serverId = body.serverId as string | undefined;
  if (!serverId) return c.json({ error: "serverId is required" }, 400);

  getRequestContext(c);
  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: serverId, action: "admin" });

  const componentName = body.component as string;

  if (!componentName || !ALLOWED_COMPONENTS.has(componentName)) {
    return c.json({ error: "Invalid or missing component name" }, 400);
  }

  const installerFn =
    COMPONENT_INSTALLERS[componentName as keyof typeof COMPONENT_INSTALLERS];
  if (!installerFn) {
    return c.json({ error: `No installer for ${componentName}` }, 400);
  }

  try {
    const logs: string[] = [];
    const installResult = await sshManager.withExecutor(serverId, (executor) =>
      installerFn(
        executor,
        (log) => logs.push(log.message),
        body.config ?? {},
      ),
    );

    return c.json({
      ...installResult,
      logs,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Installation failed";
    if (
      message === "No server configured" ||
      message === "Invalid SSH auth configuration"
    ) {
      return c.json({ error: "no_server", message }, 400);
    }
    if (isSshAuthError(err)) {
      return c.json({ error: "auth_failed", message }, 400);
    }
    return c.json({ error: "install_failed", message }, 502);
  }
}

/**
 * POST /system/remove
 *
 * Remove a specific component from a server.
 * Body: { serverId: string, component: "openresty" | "certbot" | "rsync" }
 *
 * Returns: { success: boolean, component: string, error?: string, logs?: string[] }
 */
export async function removeComponent(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const serverId = body.serverId as string | undefined;
  if (!serverId) return c.json({ error: "serverId is required" }, 400);

  getRequestContext(c);
  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: serverId, action: "admin" });

  const componentName = body.component as string;
  if (!componentName || !REMOVABLE_COMPONENTS.has(componentName)) {
    return c.json({ error: "Invalid or unsupported component name" }, 400);
  }

  const uninstallerFn = COMPONENT_UNINSTALLERS[componentName as keyof typeof COMPONENT_UNINSTALLERS];
  if (!uninstallerFn) {
    return c.json({ error: `No remover for ${componentName}` }, 400);
  }

  try {
    const logs: string[] = [];
    const result = await sshManager.withExecutor(serverId, (executor) =>
      uninstallerFn(
        executor,
        (log) => logs.push(log.message),
        body.config ?? {},
      ),
    );

    return c.json({
      ...result,
      logs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Removal failed";
    if (
      message === "No server configured" ||
      message === "Invalid SSH auth configuration"
    ) {
      return c.json({ error: "no_server", message }, 400);
    }
    if (isSshAuthError(err)) {
      return c.json({ error: "auth_failed", message }, 400);
    }
    return c.json({ error: "remove_failed", message }, 502);
  }
}

/**
 * POST /system/install/stream
 *
 * Install multiple components with real-time SSE log streaming.
 * Body: { serverId: string, components: ["docker", "openresty", ...], config?: InstallerConfig }
 *
 * Returns an SSE stream with events:
 *   - progress: component status updates
 *   - log: real-time log lines from installers
 *   - complete: final result when all installs finish
 *   - end: stream terminated
 */
export async function installStream(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const serverId = body.serverId as string | undefined;
  if (!serverId) return c.json({ error: "serverId is required" }, 400);

  getRequestContext(c);
  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: serverId, action: "admin" });

  const requestedComponents = body.components as string[] | undefined;
  const config = body.config ?? {};

  if (!requestedComponents?.length) {
    return c.json({ error: "No components specified" }, 400);
  }

  // Validate all component names
  const validNames = requestedComponents.filter((n) => ALLOWED_COMPONENTS.has(n));
  if (validNames.length === 0) {
    return c.json({ error: "Invalid component names" }, 400);
  }

  // Check for already running session
  const existing = getActiveSetupSession();
  if (existing) {
    return c.json({ error: "install_in_progress", sessionId: existing.id }, 409);
  }

  // Create session
  const componentMeta = validNames.map((name) => {
    const def = getSystemComponentDefinition(name);
    return { name, label: def.label };
  });
  const session = createSetupSession(componentMeta, serverId);

  return streamSSE(c, async (sseStream) => {
    let closed = false;

    const writer = (event: string, data: string): boolean => {
      if (closed) return false;
      try {
        void sseStream.writeSSE({ event, data });
        return true;
      } catch {
        return false;
      }
    };

    // Subscribe this connection as the first listener
    const { unsubscribe } = subscribeSetupSession(session.id, writer);

    // Run installs in background - don't await inline,
    // the SSE stream stays open via the promise below
    const installPromise = (async () => {
      let hasFailure = false;

      // Before installing OpenResty, self-heal a takeover that crashed mid-flight
      // on this server on a prior attempt (restores the previous proxy if the
      // migrate didn't finish). No-op when there's no leftover journal.
      if (validNames.includes("openresty")) {
        try {
          await sshManager.withExecutor(serverId, (executor) =>
            recoverInterruptedTakeover(executor, (l) =>
              appendSetupLog(session.id, "openresty", l.message, l.level),
            ),
          );
        } catch {
          /* best-effort */
        }
      }

      for (const name of validNames) {
        if (closed) break;

        const installerFn = COMPONENT_INSTALLERS[name as keyof typeof COMPONENT_INSTALLERS];
        if (!installerFn) {
          updateComponentProgress(session.id, name, "failed", `No installer for ${name}`);
          hasFailure = true;
          continue;
        }

        updateComponentProgress(session.id, name, "installing");

        // Bind the interactive "hold" to this session so installOpenResty can
        // pause on an edge (80/443) conflict and surface the SAME prompt modal
        // the deploy pipeline uses. Non-openresty installers ignore it.
        const promptUser: PromptUserFn = (prompt) => promptSetupUser(session.id, prompt);

        const onLog = (log: { message: string; level: "info" | "warn" | "error" }) =>
          appendSetupLog(session.id, name, log.message, log.level);

        try {
          const result = await sshManager.withExecutor(serverId, async (executor) => {
            // Single edge-prepare point: the installer raises the edge-conflict
            // consent prompt via promptUser; on "migrate", ensureEdge runs the
            // takeover. Its InstallResult is returned unchanged when no migration.
            const edge = await ensureEdge(
              executor,
              (p) => installerFn(executor, onLog, { ...config, promptUser: p }),
              { promptUser, onLog, acmeEmail: config?.acmeEmail },
            );
            if (!edge.migrated) return edge.value;
            return {
              component: name,
              success: edge.ok,
              error: edge.ok ? undefined : "migration failed — rolled back to the previous proxy",
            };
          });

          if (result.success) {
            appendSetupLog(session.id, name, `${name} installed successfully${result.version ? ` (${result.version})` : ""}`);
            updateComponentProgress(session.id, name, "installed");
          } else {
            appendSetupLog(session.id, name, result.error ?? `${name} installation failed`, "error");
            updateComponentProgress(session.id, name, "failed", result.error);
            hasFailure = true;
          }
        } catch (err) {
          const msg = safeErrorMessage(err);
          appendSetupLog(session.id, name, msg, "error");
          updateComponentProgress(session.id, name, "failed", msg);
          hasFailure = true;
        }
      }

      finishSetupSession(session.id, hasFailure ? "failed" : "completed");
    })();

    // Keep the SSE connection open until install finishes or client disconnects
    await new Promise<void>((resolve) => {
      installPromise.then(() => {
        // Give a brief delay for final events to flush
        setTimeout(() => {
          closed = true;
          resolve();
        }, 500);
      });

      sseStream.onAbort(() => {
        closed = true;
        unsubscribe();
        // If the install is parked on a prompt and the client vanished, don't
        // leave a zombie "running" session blocking retries for 5 minutes. Give
        // a short grace for a reload to reattach; if nobody does, reject the
        // prompt so the install unwinds and the session finishes.
        const grace = setTimeout(() => {
          const { pending, subscribers } = setupPromptState(session.id);
          if (pending && subscribers === 0) {
            rejectPendingSetupPrompt(session.id, "client disconnected");
          }
        }, 20_000);
        if (typeof grace.unref === "function") grace.unref();
        resolve();
      });
    });
  });
}

/**
 * GET /system/install/session
 *
 * Get the active setup session or a specific session by ID.
 * Query: ?id=setup_xxx (optional - returns active session if omitted)
 *
 * Returns: session state or 404
 */
export async function getInstallSession(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const sessionId = c.req.query("id");

  const session = sessionId
    ? getSetupSession(sessionId)
    : getActiveSetupSession();

  if (!session) {
    return c.json({ active: false }, 200);
  }

  // Gate to org members with admin rights over the session's target server.
  // Sessions are server-scoped, so existence-leak protection applies via the
  // server resource (404-shape).
  getRequestContext(c);
  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: session.serverId, action: "admin" });

  return c.json({
    active: true,
    sessionId: session.id,
    serverId: session.serverId,
    status: session.status,
    components: session.components,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
  });
}

/**
 * GET /system/install/stream
 *
 * Attach to an existing setup session's SSE stream (for page reloads).
 * Query: ?id=setup_xxx
 */
export async function attachInstallStream(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const sessionId = c.req.query("id");
  const session = sessionId
    ? getSetupSession(sessionId)
    : getActiveSetupSession();

  if (!session) {
    return c.json({ error: "No active session" }, 404);
  }

  // Gate by the session's underlying server before opening the SSE stream.
  getRequestContext(c);
  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: session.serverId, action: "admin" });

  return streamSSE(c, async (sseStream) => {
    let closed = false;

    const writer = (event: string, data: string): boolean => {
      if (closed) return false;
      try {
        void sseStream.writeSSE({ event, data });
        return true;
      } catch {
        return false;
      }
    };

    const { success, unsubscribe } = subscribeSetupSession(session.id, writer);

    if (!success) {
      await sseStream.writeSSE({ event: "error", data: JSON.stringify({ error: "Session not found" }) });
      return;
    }

    // If session is already done, subscribe will have replayed + sent end; just close
    if (session.status !== "running") {
      return;
    }

    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (closed) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);

      sseStream.onAbort(() => {
        closed = true;
        unsubscribe();
        clearInterval(checkInterval);
        resolve();
      });
    });
  });
}

// ─── Monitoring ──────────────────────────────────────────────────────────────

/**
 * Shell one-liner that gathers CPU, memory, disk, uptime, and load average.
 * Outputs a single JSON line. Designed for Linux servers.
 *
 * Fields:
 *   cpu      - usage % (100 - idle from /proc/stat snapshot)
 *   memTotal - total RAM bytes
 *   memUsed  - used RAM bytes (total - available)
 *   memAvail - available RAM bytes
 *   diskTotal - root partition total bytes
 *   diskUsed  - root partition used bytes
 *   diskAvail - root partition available bytes
 *   uptime   - seconds since boot
 *   load1    - 1-min load average
 *   load5    - 5-min load average
 *   load15   - 15-min load average
 */
const STATS_COMMAND = [
  // CPU: sample /proc/stat twice (200ms apart) for accurate usage
  'read cpu0_u cpu0_n cpu0_s cpu0_i cpu0_rest <<< $(head -1 /proc/stat | awk \'{print $2,$3,$4,$5}\');',
  'sleep 0.2;',
  'read cpu1_u cpu1_n cpu1_s cpu1_i cpu1_rest <<< $(head -1 /proc/stat | awk \'{print $2,$3,$4,$5}\');',
  'cpu_d=$(( (cpu1_u-cpu0_u)+(cpu1_n-cpu0_n)+(cpu1_s-cpu0_s)+(cpu1_i-cpu0_i) ));',
  'cpu_idle=$(( cpu1_i - cpu0_i ));',
  '[ "$cpu_d" -gt 0 ] && cpu_pct=$(( 100 - (cpu_idle * 100 / cpu_d) )) || cpu_pct=0;',
  // Memory
  'read mem_t mem_a <<< $(awk \'/MemTotal/{t=$2} /MemAvailable/{a=$2} END{print t*1024, a*1024}\' /proc/meminfo);',
  'mem_u=$((mem_t - mem_a));',
  // Disk
  'read disk_t disk_u disk_a <<< $(df -B1 / | awk \'NR==2{print $2,$3,$4}\');',
  // Uptime + load
  'read up_s _ <<< $(cat /proc/uptime);',
  'read l1 l5 l15 _ _ <<< $(cat /proc/loadavg);',
  // Output JSON
  'printf \'{"cpu":%d,"memTotal":%s,"memUsed":%s,"memAvail":%s,"diskTotal":%s,"diskUsed":%s,"diskAvail":%s,"uptime":"%s","load1":"%s","load5":"%s","load15":"%s"}\\n\' "$cpu_pct" "$mem_t" "$mem_u" "$mem_a" "$disk_t" "$disk_u" "$disk_a" "$up_s" "$l1" "$l5" "$l15"',
].join(" ");

/**
 * GET /system/monitor/stream
 *
 * SSE stream that emits system stats every few seconds.
 * Runs a lightweight stats command via SSH on an interval.
 * Stops when the client disconnects.
 *
 * Query: ?serverId=<uuid>
 */
export async function monitorStream(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const serverId = c.req.query("serverId");
  if (!serverId) return c.json({ error: "serverId query param is required" }, 400);

  getRequestContext(c);
  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: serverId, action: "read" });

  const POLL_INTERVAL = 3_000;
  // Generous per-sample timeout: on the system-ssh (agent) path each exec is a
  // fresh ssh process + ControlMaster channel + remote shell, so the heavy
  // /proc one-liner can take a few seconds on a busy box. 5s was too tight.
  const STATS_TIMEOUT_MS = 12_000;

  return streamSSE(c, async (sseStream) => {
    sshManager.retain(serverId);
    const ac = new AbortController();
    sseStream.onAbort(() => ac.abort());

    try {
      while (!ac.signal.aborted) {
        try {
          // Use acquire()+exec() rather than withExecutor(): this is a
          // best-effort background poller, and its timeouts must NOT count
          // toward the circuit breaker (which would penalize the whole server
          // for a slow metrics sample). A failed sample just retries next tick.
          const executor = await sshManager.acquire(serverId);
          const raw = await executor.exec(STATS_COMMAND, { timeout: STATS_TIMEOUT_MS });
          if (ac.signal.aborted) break;
          JSON.parse(raw); // validate
          await sseStream.writeSSE({ event: "stats", data: raw });
        } catch (err) {
          if (ac.signal.aborted) break;
          const msg = safeErrorMessage(err);
          await sseStream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: msg }),
          });
        }
        // Abort-aware sleep
        await new Promise<void>((resolve) => {
          if (ac.signal.aborted) return resolve();
          const timer = setTimeout(resolve, POLL_INTERVAL);
          ac.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    } finally {
      sshManager.release(serverId);
    }
  });
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
export async function scanExposedPorts(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const organizationId = getRequestContext(c).organizationId;
  const serverId = c.req.param("id")!;
  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: serverId, action: "read" });

  const server = await repos.server.getInOrganization(serverId, organizationId);
  if (!server) return c.json({ error: "Server not found" }, 404);

  const reachable = await sshManager.probeReachable(serverId).catch(() => false);
  if (!reachable) {
    return c.json({ error: "unreachable", message: "Server is not reachable over SSH right now." }, 502);
  }

  try {
    const result = await sshManager.withExecutor(serverId, (executor) => scanPorts(executor));
    const enriched = await confirmReachability(result, server.sshHost);
    return c.json(enriched);
  } catch (err) {
    const message = safeErrorMessage(err);
    if (isSshAuthError(err)) return c.json({ error: "auth_failed", message }, 400);
    return c.json({ error: "scan_failed", message }, 502);
  }
}

// Off-box reachability probe: the scan's `exposed` flag only means "bound to a
// non-loopback interface" — a cloud/host firewall (Hetzner, ufw, security group)
// can still block it. So we dial each exposed TCP port from the API host to learn
// which are ACTUALLY reachable vs bound-but-blocked. Bounded (cap + concurrency +
// short timeout) so a box full of firewalled ports can't stall the request.
const REACHABILITY_MAX_PORTS = 50;
const REACHABILITY_CONCURRENCY = 16;
const REACHABILITY_TIMEOUT_MS = 1_500;

async function confirmReachability(
  result: PortScanResult,
  host: string | null,
): Promise<PortScanResult> {
  // Only meaningful against a real remote target — an off-box dial to
  // loopback/localhost tells us nothing about internet exposure.
  const dialable = host && !/^(127\.|::1$|localhost$)/i.test(host.trim());
  if (!result.scanned || !dialable) {
    return { ...result, reachabilityProbed: false, reachableCount: 0 };
  }

  const targets = [
    ...new Set(
      result.listeners.filter((l) => l.exposed && l.proto === "tcp").map((l) => l.port),
    ),
  ].slice(0, REACHABILITY_MAX_PORTS);

  const reachable = new Map<number, boolean>();
  const queue = [...targets];
  const workers = Array.from(
    { length: Math.min(REACHABILITY_CONCURRENCY, queue.length) },
    async () => {
      for (let port = queue.shift(); port !== undefined; port = queue.shift()) {
        const ok = await probeTcp(host!.trim(), port, REACHABILITY_TIMEOUT_MS).catch(() => false);
        reachable.set(port, ok);
      }
    },
  );
  await Promise.all(workers);

  const listeners = result.listeners.map((l) =>
    l.exposed && l.proto === "tcp" && reachable.has(l.port)
      ? { ...l, reachable: reachable.get(l.port)! }
      : l,
  );

  return {
    ...result,
    listeners,
    reachabilityProbed: true,
    reachableCount: listeners.filter((l) => l.reachable === true).length,
  };
}
