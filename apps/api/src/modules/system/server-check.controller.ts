/**
 * Server check & install controller — runs system health checks and
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
import { streamSSE } from "hono/streaming";
import { env } from "../../config";
import {
  checkComponents,
  type CommandExecutor,
  createExecutor,
  COMPONENT_INSTALLERS,
  COMPONENT_UNINSTALLERS,
  getRemovalSupport,
  isSshAuthError,
  SYSTEM_COMPONENTS,
  getSystemComponentDefinition,
} from "@repo/adapters";
import { formatDuration, systemDebug } from "@/lib/system-debug";
import { sshManager, buildSshConfig } from "../../lib/ssh-manager";
import {
  createSetupSession,
  getSetupSession,
  getActiveSetupSession,
  updateComponentProgress,
  appendSetupLog,
  finishSetupSession,
  subscribeSetupSession,
} from "./setup-session";

function debugSystemRequest(message: string): void {
  systemDebug("system-check", message);
}

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
 * Infrastructure components — optional but important for app deployment.
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
export async function testConnection(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const startedAt = Date.now();
  const result = await buildEphemeralExecutor(c);

  if (result instanceof Response) return result; // validation error already sent
  const executor = result;

  try {
    debugSystemRequest(`test-connection:start`);
    const output = await executor.exec("echo ok", { timeout: 15_000 });
    const success = output.trim() === "ok";
    debugSystemRequest(`test-connection:done ok=${success} (${formatDuration(startedAt)})`);
    return c.json({ ok: success, message: success ? "Connection successful" : "Unexpected response" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to connect";
    debugSystemRequest(`test-connection:failed ${message} (${formatDuration(startedAt)})`);

    if (isSshAuthError(err)) {
      return c.json({ ok: false, message: "Authentication failed — check your credentials" }, 400);
    }
    return c.json({ ok: false, message }, 502);
  } finally {
    await executor.dispose();
  }
}

/**
 * Build an ephemeral SshExecutor from request body credentials.
 * Returns the executor on success, or sends an error response and returns null.
 */
async function buildEphemeralExecutor(c: Context) {
  const body = await c.req.json().catch(() => ({}));
  const host = (body.sshHost as string)?.trim();
  if (!host) {
    return c.json({ ok: false, message: "SSH host is required" }, 400);
  }

  const config = await buildSshConfig({
    sshHost: host,
    sshPort: body.sshPort ? Number(body.sshPort) : null,
    sshUser: (body.sshUser as string) || null,
    sshAuthMethod: body.sshAuthMethod as string,
    sshPassword: body.sshPassword as string ?? null,
    sshKeyPath: body.sshKeyPath as string ?? null,
    sshKeyPassphrase: body.sshKeyPassphrase as string ?? null,
  });

  if (!config) {
    return c.json({ ok: false, message: "Invalid auth configuration" }, 400);
  }

  return createExecutor(config);
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

    const requestedComponents = body.components as string[] | undefined;
    debugSystemRequest(
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

    debugSystemRequest(
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
    debugSystemRequest(`check:failed ${message} (${formatDuration(startedAt)})`);
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

    // Run installs in background — don't await inline,
    // the SSE stream stays open via the promise below
    const installPromise = (async () => {
      let hasFailure = false;

      for (const name of validNames) {
        if (closed) break;

        const installerFn = COMPONENT_INSTALLERS[name as keyof typeof COMPONENT_INSTALLERS];
        if (!installerFn) {
          updateComponentProgress(session.id, name, "failed", `No installer for ${name}`);
          hasFailure = true;
          continue;
        }

        updateComponentProgress(session.id, name, "installing");

        try {
          const result = await sshManager.withExecutor(serverId, (executor) =>
            installerFn(
              executor,
              (log) => appendSetupLog(session.id, name, log.message, log.level),
              config,
            ),
          );

          if (result.success) {
            appendSetupLog(session.id, name, `${name} installed successfully${result.version ? ` (${result.version})` : ""}`);
            updateComponentProgress(session.id, name, "installed");
          } else {
            appendSetupLog(session.id, name, result.error ?? `${name} installation failed`, "error");
            updateComponentProgress(session.id, name, "failed", result.error);
            hasFailure = true;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
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
        resolve();
      });
    });
  });
}

/**
 * GET /system/install/session
 *
 * Get the active setup session or a specific session by ID.
 * Query: ?id=setup_xxx (optional — returns active session if omitted)
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

  const POLL_INTERVAL = 3_000;

  return streamSSE(c, async (sseStream) => {
    let closed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let consecutiveWriteErrors = 0;

    const cleanup = () => {
      closed = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const poll = async () => {
      if (closed) return;
      try {
        const raw = await sshManager.withExecutor<string>(
          serverId,
          (executor: CommandExecutor) =>
          executor.exec(STATS_COMMAND, { timeout: 5_000 }),
        );
        if (closed) return;
        // Validate it's parseable JSON before sending
        JSON.parse(raw);
        try {
          await sseStream.writeSSE({ event: "stats", data: raw });
          consecutiveWriteErrors = 0;
        } catch {
          consecutiveWriteErrors++;
          if (consecutiveWriteErrors >= 2) cleanup();
          return;
        }
      } catch (err) {
        if (closed) return;
        try {
          const msg = err instanceof Error ? err.message : String(err);
          await sseStream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: msg }),
          });
          consecutiveWriteErrors = 0;
        } catch {
          // Write failed — client likely disconnected
          consecutiveWriteErrors++;
          if (consecutiveWriteErrors >= 2) {
            cleanup();
          }
        }
      }
    };

    // First poll immediately
    await poll();

    // Then poll on interval
    if (!closed) {
      pollTimer = setInterval(() => void poll(), POLL_INTERVAL);
    }

    // Wait until client disconnects
    await new Promise<void>((resolve) => {
      sseStream.onAbort(() => {
        cleanup();
        resolve();
      });
    });
  });
}
