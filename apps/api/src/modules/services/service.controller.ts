/**
 * Service controller — Hono request handlers for compose services.
 */

import type { Context } from "hono";
import { getUserId, param } from "../../lib/controller-helpers";
import * as serviceService from "./service.service";
import type { TUpdateServiceBody, TSetServiceEnvVarsBody } from "./service.schema";

// ─── List services for a project ─────────────────────────────────────────────

export async function list(c: Context) {
  const userId = getUserId(c);
  const projectId = param(c, "id");

  try {
    const services = await serviceService.listServices(projectId, userId);
    return c.json({ success: true, services });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list services";
    return c.json({ success: false, error: message }, 400);
  }
}

// ─── Get single service ──────────────────────────────────────────────────────

export async function getById(c: Context) {
  const userId = getUserId(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");

  try {
    const svc = await serviceService.getService(projectId, serviceId, userId);
    return c.json({ success: true, service: svc });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get service";
    const status = message === "service-not-found" || message === "project-not-found" ? 404 : 400;
    return c.json({ success: false, error: message }, status);
  }
}

// ─── Update service config ───────────────────────────────────────────────────

export async function update(c: Context) {
  const userId = getUserId(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  const body = await c.req.json<TUpdateServiceBody>();

  try {
    const svc = await serviceService.updateService(projectId, serviceId, userId, body);
    return c.json({ success: true, service: svc });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update service";
    return c.json({ success: false, error: message }, 400);
  }
}

// ─── Service environment variables ───────────────────────────────────────────

export async function listEnvVars(c: Context) {
  const userId = getUserId(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  const environment = c.req.query("environment") || undefined;

  try {
    const vars = await serviceService.listServiceEnvVars(projectId, serviceId, userId, environment);
    return c.json({ success: true, vars });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list env vars";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function setEnvVars(c: Context) {
  const userId = getUserId(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  const body = await c.req.json<TSetServiceEnvVarsBody>();

  try {
    const result = await serviceService.setServiceEnvVars(projectId, serviceId, userId, body);
    return c.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to set env vars";
    return c.json({ success: false, error: message }, 400);
  }
}

// ─── Active containers (for observability) ───────────────────────────────────

export async function activeContainers(c: Context) {
  const userId = getUserId(c);
  const projectId = param(c, "id");

  try {
    const containers = await serviceService.getActiveServiceContainers(projectId, userId);
    return c.json({ success: true, containers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get containers";
    return c.json({ success: false, error: message }, 400);
  }
}

// ─── Sync from compose file ──────────────────────────────────────────────────

export async function syncFromCompose(c: Context) {
  const userId = getUserId(c);
  const projectId = param(c, "id");
  const body = await c.req.json<{
    services: Array<{
      name: string;
      image?: string;
      build?: string;
      dockerfile?: string;
      ports?: string[];
      dependsOn?: string[];
      environment?: Record<string, string>;
      volumes?: string[];
      command?: string;
      restart?: string;
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

  try {
    const services = await serviceService.syncComposeServices(projectId, userId, body.services);
    return c.json({ success: true, services });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to sync services";
    return c.json({ success: false, error: message }, 400);
  }
}

// ─── Per-service container actions ───────────────────────────────────────────

export async function startContainer(c: Context) {
  const userId = getUserId(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  try {
    await serviceService.startServiceContainer(projectId, serviceId, userId);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start container";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function stopContainer(c: Context) {
  const userId = getUserId(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  try {
    await serviceService.stopServiceContainer(projectId, serviceId, userId);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to stop container";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function restartContainer(c: Context) {
  const userId = getUserId(c);
  const projectId = param(c, "id");
  const serviceId = param(c, "serviceId");
  try {
    await serviceService.restartServiceContainer(projectId, serviceId, userId);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to restart container";
    return c.json({ success: false, error: message }, 400);
  }
}
