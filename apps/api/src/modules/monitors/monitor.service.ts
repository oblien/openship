/**
 * Monitor service — per-project uptime monitor CRUD + history reads.
 *
 * The probe loop lives in lib/monitor-runner.ts; this service only
 * manages configuration rows and the read models for the Monitoring tab.
 * Every function asserts the project belongs to the caller's org and
 * that a child monitor belongs to the project (404 on mismatch — never
 * reveal cross-tenant existence).
 */

import { repos, type Monitor, type MonitorCheck, type MonitorIncident } from "@repo/db";
import { NotFoundError } from "@repo/core";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import type { TCreateMonitorBody, TUpdateMonitorBody } from "./monitor.schema";

export interface MonitorWithUptime extends Monitor {
  /** % of successful checks over the last 24h. Null with no checks yet. */
  uptime24h: number | null;
}

async function loadOwnedProject(ctx: RequestContext, projectId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  return project;
}

async function loadOwnedMonitor(
  ctx: RequestContext,
  projectId: string,
  monitorId: string,
): Promise<Monitor> {
  await loadOwnedProject(ctx, projectId);
  const monitor = await repos.monitor.findById(monitorId);
  if (!monitor || monitor.projectId !== projectId) {
    throw new NotFoundError("Monitor", monitorId);
  }
  return monitor;
}

// ─── List ────────────────────────────────────────────────────────────────────

export async function listMonitors(
  ctx: RequestContext,
  projectId: string,
): Promise<MonitorWithUptime[]> {
  await loadOwnedProject(ctx, projectId);
  const monitors = await repos.monitor.listByProject(projectId);
  return Promise.all(
    monitors.map(async (mon) => {
      const checks = await repos.monitorCheck.listRecent(mon.id, 24);
      const okCount = checks.filter((chk) => chk.ok).length;
      const uptime24h = checks.length ? Math.round((okCount / checks.length) * 10_000) / 100 : null;
      return { ...mon, uptime24h };
    }),
  );
}

// ─── Create ──────────────────────────────────────────────────────────────────

export async function createMonitor(
  ctx: RequestContext,
  projectId: string,
  body: TCreateMonitorBody,
): Promise<Monitor> {
  const project = await loadOwnedProject(ctx, projectId);
  return repos.monitor.create({
    organizationId: project.organizationId,
    projectId: project.id,
    createdBy: ctx.userId,
    name: body.name,
    url: body.url,
    intervalSeconds: body.intervalSeconds ?? 60,
    timeoutMs: body.timeoutMs ?? 10_000,
    expectedStatus: body.expectedStatus ?? null,
    failureThreshold: body.failureThreshold ?? 3,
    enabled: body.enabled ?? true,
  });
}

// ─── Update ──────────────────────────────────────────────────────────────────

export async function updateMonitor(
  ctx: RequestContext,
  projectId: string,
  monitorId: string,
  body: TUpdateMonitorBody,
): Promise<Monitor | undefined> {
  await loadOwnedMonitor(ctx, projectId, monitorId);

  const patch: Partial<
    Pick<
      Monitor,
      | "name"
      | "url"
      | "intervalSeconds"
      | "timeoutMs"
      | "expectedStatus"
      | "failureThreshold"
      | "enabled"
    >
  > = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.url !== undefined) patch.url = body.url;
  if (body.intervalSeconds !== undefined) patch.intervalSeconds = body.intervalSeconds;
  if (body.timeoutMs !== undefined) patch.timeoutMs = body.timeoutMs;
  if (body.expectedStatus !== undefined) patch.expectedStatus = body.expectedStatus;
  if (body.failureThreshold !== undefined) patch.failureThreshold = body.failureThreshold;
  if (body.enabled !== undefined) patch.enabled = body.enabled;

  return repos.monitor.update(monitorId, patch);
}

// ─── Delete ──────────────────────────────────────────────────────────────────

export async function deleteMonitor(
  ctx: RequestContext,
  projectId: string,
  monitorId: string,
): Promise<void> {
  await loadOwnedMonitor(ctx, projectId, monitorId);
  await repos.monitor.remove(monitorId);
}

// ─── History reads ───────────────────────────────────────────────────────────

export async function listChecks(
  ctx: RequestContext,
  projectId: string,
  monitorId: string,
  hours: number,
): Promise<MonitorCheck[]> {
  await loadOwnedMonitor(ctx, projectId, monitorId);
  return repos.monitorCheck.listRecent(monitorId, hours);
}

export async function listIncidents(
  ctx: RequestContext,
  projectId: string,
  monitorId: string,
): Promise<MonitorIncident[]> {
  await loadOwnedMonitor(ctx, projectId, monitorId);
  return repos.monitorIncident.listByMonitor(monitorId);
}
