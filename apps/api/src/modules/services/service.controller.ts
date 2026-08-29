/**
 * Service controller - Hono request handlers for compose services.
 *
 * Access is enforced by the secureRouter middleware mounted on each
 * route (project:service:read|write|admin tags). By the time a handler
 * runs, the user's membership in the project's org is verified.
 * Controllers pull the resolved organizationId from the context and
 * pass it down to the service layer for defense-in-depth.
 */

import type { Context } from "hono";
import { AppError, type ComposeAdvanced } from "@repo/core";
import { streamSSE } from "../../lib/sse";
import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { parseRevealKeys, pickRevealed } from "../../lib/env-reveal";
import { parseOptionalEnvironmentScope } from "../../lib/environment-scope";
import { audit, auditContextFrom } from "../../lib/audit";
import { sshManager } from "../../lib/ssh-manager";
import * as serviceService from "./service.service";
import { ServiceConfigStaleError } from "../deployments/env-drift";
import type {
  TCreateServiceBody,
  TUpdateServiceBody,
  TSetServiceEnvVarsBody,
} from "./service.schema";

// ─── List services for a project ─────────────────────────────────────────────

export async function list(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");

  try {
    const services = await serviceService.listServices(ctx, projectId);
    return c.json({ success: true, services });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list services";
    return c.json({ success: false, error: message }, 400);
  }
}

// ─── Get single service ──────────────────────────────────────────────────────

export async function getById(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");

  try {
    const svc = await serviceService.getService(ctx, projectId, serviceId);
    return c.json({ success: true, service: svc });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get service";
    const status =
      (err instanceof AppError && err.statusCode === 404) || message === "service-not-found" ? 404 : 400;
    return c.json({ success: false, error: message }, status);
  }
}

// ─── Reveal real env (#336) — write-gated, backs the "show values" toggle ─────

/**
 * POST /projects/:id/services/:serviceId/env-reveal  { keys: string[] }
 *
 * Per-key: returns plaintext for the named keys ONLY, so pressing one row's eye
 * discloses one secret. `keys` is required (see parseRevealKeys) — no request can
 * ask for the whole map. The auto-emitted `project:service:write` audit row
 * carries the disclosed key names via `auditAfter`.
 */
export async function revealEnv(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  // Outside the try: a 400 from key validation must not be reported as a
  // reveal failure. Body may be absent on a malformed client call.
  const body = await c.req
    .json<{ keys?: unknown; environment?: unknown }>()
    .catch(() => ({}) as { keys?: unknown; environment?: unknown });
  const keys = parseRevealKeys(body.keys);
  const revealEnvironment = parseOptionalEnvironmentScope(body.environment);

  try {
    const stored = revealEnvironment
      ? await serviceService.revealServiceEnvVars(ctx, projectId, serviceId, revealEnvironment)
      : await serviceService.revealServiceEnv(ctx, projectId, serviceId);
    const environment = pickRevealed(stored, keys);
    c.set("auditAfter", { revealedEnvKeys: Object.keys(environment) });
    return c.json({ success: true, environment });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reveal service env";
    const status =
      (err instanceof AppError && err.statusCode === 404) || message === "service-not-found" ? 404 : 400;
    return c.json({ success: false, error: message }, status);
  }
}

// ─── Volume disk usage ───────────────────────────────────────────────────────

export async function volumeSizes(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");

  try {
    const result = await serviceService.getServiceVolumeSizes(ctx, projectId, serviceId);
    return c.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to measure volume sizes";
    const status =
      (err instanceof AppError && err.statusCode === 404) || message === "service-not-found" ? 404 : 400;
    return c.json({ success: false, error: message }, status);
  }
}

// ─── Create / update / delete service config ─────────────────────────────────

export async function create(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const body = await c.req.json<TCreateServiceBody>();

  try {
    const svc = await serviceService.createService(ctx, projectId, body);
    return c.json({ success: true, service: svc }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create service";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function update(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  const body = await c.req.json<TUpdateServiceBody>();

  try {
    const svc = await serviceService.updateService(ctx, projectId, serviceId, body);
    return c.json({ success: true, service: svc });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update service";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function remove(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");

  try {
    await serviceService.deleteService(ctx, projectId, serviceId);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete service";
    return c.json({ success: false, error: message }, 400);
  }
}

// ─── Compose drift (repo re-parse reconciliation) ────────────────────────────

export async function acceptDrift(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  try {
    const svc = await serviceService.acceptServiceDrift(ctx, projectId, serviceId);
    return c.json({ success: true, service: svc });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to accept drift";
    const status =
      (err instanceof AppError && err.statusCode === 404) || message === "service-not-found" ? 404 : 400;
    return c.json({ success: false, error: message }, status);
  }
}

export async function keepDrift(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  try {
    const svc = await serviceService.keepServiceDrift(ctx, projectId, serviceId);
    return c.json({ success: true, service: svc });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to keep edits";
    const status =
      (err instanceof AppError && err.statusCode === 404) || message === "service-not-found" ? 404 : 400;
    return c.json({ success: false, error: message }, status);
  }
}

// ─── Service environment variables ───────────────────────────────────────────

export async function listEnvVars(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  const environment = c.req.query("environment") || undefined;

  try {
    const vars = await serviceService.listServiceEnvVars(ctx, projectId, serviceId, environment);
    return c.json({ success: true, vars });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list env vars";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function setEnvVars(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  const body = await c.req.json<TSetServiceEnvVarsBody>();

  try {
    const result = await serviceService.setServiceEnvVars(ctx, projectId, serviceId, body);
    return c.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to set env vars";
    return c.json({ success: false, error: message }, 400);
  }
}

// ─── Active containers (for observability) ───────────────────────────────────

export async function activeContainers(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");

  try {
    const containers = await serviceService.getActiveServiceContainers(ctx, projectId);
    return c.json({ success: true, containers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get containers";
    return c.json({ success: false, error: message }, 400);
  }
}

// ─── Sync from compose file ──────────────────────────────────────────────────

export async function syncFromCompose(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const body = await c.req.json<{
    services: Array<{
      name: string;
      image?: string;
      build?: string;
      dockerfile?: string;
      buildArgs?: Record<string, string | null>;
      ports?: string[];
      dependsOn?: string[];
      environment?: Record<string, string>;
      volumes?: string[];
      command?: string;
      /** #332: exact argv — no `sh -c`. Wins over the lossy `command` string. */
      commandArgv?: string[];
      restart?: string;
      /** Raw Compose interpolation provenance and the remaining extended
       * compose fields accepted by the sync schema. */
      advanced?: ComposeAdvanced;
      exposed?: boolean;
      exposedPort?: string;
      domain?: string;
      customDomain?: string;
      domainType?: "free" | "custom";
    }>;
  }>();

  if (!body.services || !Array.isArray(body.services)) {
    return c.json({ success: false, error: "services array is required" }, 400);
  }

  if (body.services.length === 0) {
    return c.json({ success: false, error: "Refusing to sync an empty compose service list" }, 400);
  }

  try {
    const services = await serviceService.syncComposeServices(ctx, projectId, body.services);
    return c.json({ success: true, services });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to sync services";
    return c.json({ success: false, error: message }, 400);
  }
}

// ─── Per-service container actions ───────────────────────────────────────────

export async function startContainer(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  try {
    await serviceService.startServiceContainer(ctx, projectId, serviceId);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start container";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function stopContainer(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  try {
    await serviceService.stopServiceContainer(ctx, projectId, serviceId);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to stop container";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function restartContainer(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  // Read raw off the query string rather than declaring a `query` schema on the
  // route: `RouteSpec` has no such field (secureRouter only auto-wires `body`),
  // and declaring a body on this previously body-less POST would 400 every
  // caller that sends `Content-Type: application/json` with no body — which the
  // CLI's api-client does unconditionally.
  const force = ["true", "1"].includes(c.req.query("force") ?? "");
  try {
    const result = await serviceService.restartServiceContainer(ctx, projectId, serviceId, {
      force,
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    // A stale-config refusal is a 409 with structure, not a generic 400: the
    // caller needs the code to branch on and the key names to see WHY a restart
    // was refused. Everything else keeps the historical 400.
    if (err instanceof ServiceConfigStaleError) {
      return c.json(
        {
          success: false,
          error: err.message,
          code: err.code,
          staleEnvKeys: err.staleEnvKeys,
          serviceName: err.serviceName,
        },
        409,
      );
    }
    const message = err instanceof Error ? err.message : "Failed to restart container";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function runtimeLogs(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  const tail = c.req.query("tail") ? Number(c.req.query("tail")) : undefined;

  try {
    const entries = await serviceService.getServiceRuntimeLogs(ctx, projectId, serviceId, tail);
    return c.json({ data: entries });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get logs";
    return c.json({ error: message }, 400);
  }
}

/**
 * POST /api/projects/:id/services/:serviceId/exec — run a command inside the
 * service's running container.
 *
 * Scoped by the route's `project:service:write` tag, so a project grant confines an
 * agent to that project's services. See `execInServiceContainer` for why `write` is
 * the right tier.
 */
export async function execInService(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");

  const body = await c.req.json<{
    command?: string;
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  }>();
  const command = body.command?.trim();
  if (!command) return c.json({ error: "command required", code: "COMMAND_REQUIRED" }, 400);

  try {
    const result = await serviceService.execInServiceContainer(ctx, projectId, serviceId, {
      command,
      cwd: body.cwd,
      timeoutMs: body.timeoutMs,
      maxOutputBytes: body.maxOutputBytes,
    });

    // The command is recorded, the output is not: output is unbounded and may carry
    // secrets the command read. Same rule as the host exec audit.
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: "service.exec",
      resourceType: "service",
      resourceId: serviceId,
      after: {
        projectId,
        command,
        cwd: body.cwd ?? null,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.durationMs,
        outputBytes: result.output.length,
      },
    });

    return c.json({ data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to run the command";
    return c.json({ error: message }, 400);
  }
}

export async function runtimeLogStream(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  const tail = c.req.query("tail") ? Number(c.req.query("tail")) : undefined;

  return streamSSE(c, async (sseStream) => {
    let cleanup: (() => void) | null = null;
    let serverId: string | null = null;

    try {
      const result = await serviceService.streamServiceRuntimeLogs(
        ctx,
        projectId,
        serviceId,
        (entry) => {
          void sseStream.writeSSE({
            event: "log",
            data: JSON.stringify({
              type: "log",
              data: entry.rawData,
              message: entry.message,
              timestamp: entry.timestamp,
              level: entry.level,
            }),
          });
        },
        { tail },
      );

      cleanup = result.cleanup;
      serverId = result.serverId;
      if (serverId) sshManager.retain(serverId);

      await new Promise<void>((resolve) => {
        sseStream.onAbort(() => {
          cleanup?.();
          resolve();
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stream logs";
      await sseStream.writeSSE({ event: "error", data: JSON.stringify({ error: message }) });
      cleanup?.();
    } finally {
      if (serverId) sshManager.release(serverId);
    }
  });
}
