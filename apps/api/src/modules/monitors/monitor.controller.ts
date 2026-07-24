/**
 * Monitor controller — per-project uptime monitors (Monitoring tab).
 *
 *   GET    /api/projects/:id/monitors
 *   POST   /api/projects/:id/monitors
 *   PATCH  /api/projects/:id/monitors/:monitorId
 *   DELETE /api/projects/:id/monitors/:monitorId
 *   GET    /api/projects/:id/monitors/:monitorId/checks?hours=24
 *   GET    /api/projects/:id/monitors/:monitorId/incidents
 *
 * Self-hosted only (mounted behind localOnly). Probing is done by the
 * monitor runner (lib/monitor-runner); these handlers only manage config
 * rows and read check/incident history.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { getRequestContext } from "../../lib/request-context";
import { param } from "../../lib/controller-helpers";
import * as monitorService from "./monitor.service";
import type { TCreateMonitorBody, TUpdateMonitorBody } from "./monitor.schema";

async function loadProject(c: Context) {
  const organizationId = getRequestContext(c).organizationId;
  const project = await repos.project.findById(param(c, "id"));
  if (!project || project.organizationId !== organizationId) return null;
  return project;
}

async function loadProjectMonitor(c: Context, projectId: string) {
  const monitor = await repos.monitor.findById(param(c, "monitorId"));
  if (!monitor || monitor.projectId !== projectId) return null;
  return monitor;
}

export async function listMonitors(c: Context) {
  const project = await loadProject(c);
  if (!project) return c.json({ error: "Project not found" }, 404);
  const data = await monitorService.listMonitors(getRequestContext(c), project.id);
  return c.json({ data });
}

export async function createMonitor(c: Context) {
  const project = await loadProject(c);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const body = await c.req.json<TCreateMonitorBody>();
  try {
    const data = await monitorService.createMonitor(getRequestContext(c), project.id, body);
    return c.json({ data }, 201);
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function updateMonitor(c: Context) {
  const project = await loadProject(c);
  if (!project) return c.json({ error: "Project not found" }, 404);
  const monitor = await loadProjectMonitor(c, project.id);
  if (!monitor) return c.json({ error: "Monitor not found" }, 404);

  const body = await c.req.json<TUpdateMonitorBody>();
  try {
    const data = await monitorService.updateMonitor(
      getRequestContext(c),
      project.id,
      monitor.id,
      body,
    );
    return c.json({ data });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function deleteMonitor(c: Context) {
  const project = await loadProject(c);
  if (!project) return c.json({ error: "Project not found" }, 404);
  const monitor = await loadProjectMonitor(c, project.id);
  if (!monitor) return c.json({ error: "Monitor not found" }, 404);

  await monitorService.deleteMonitor(getRequestContext(c), project.id, monitor.id);
  return c.json({ success: true });
}

export async function listMonitorChecks(c: Context) {
  const project = await loadProject(c);
  if (!project) return c.json({ error: "Project not found" }, 404);
  const monitor = await loadProjectMonitor(c, project.id);
  if (!monitor) return c.json({ error: "Monitor not found" }, 404);

  const hoursRaw = c.req.query("hours");
  const hours = hoursRaw === undefined ? 24 : Number(hoursRaw);
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
    return c.json({ error: "hours must be between 1 and 168" }, 400);
  }

  const data = await monitorService.listChecks(
    getRequestContext(c),
    project.id,
    monitor.id,
    Math.floor(hours),
  );
  return c.json({ data });
}

export async function listMonitorIncidents(c: Context) {
  const project = await loadProject(c);
  if (!project) return c.json({ error: "Project not found" }, 404);
  const monitor = await loadProjectMonitor(c, project.id);
  if (!monitor) return c.json({ error: "Monitor not found" }, 404);

  const data = await monitorService.listIncidents(getRequestContext(c), project.id, monitor.id);
  return c.json({ data });
}
