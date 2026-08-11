/**
 * Incident lifecycle — the layer that turns "a poller noticed something" into an
 * alert an operator will still have enabled next week.
 *
 * A watcher that notifies on what it SEES is unusable: a container in a restart
 * loop is broken on every tick, so a 60s poll pages 60 times an hour about one
 * fault. The unit of alerting here is therefore not a state but an incident —
 * opened once, escalated only when the fault gets strictly worse, closed once with
 * how long it lasted. Three messages, worst case, for an outage of any length.
 *
 * Two rules do the work:
 *
 *   1. `kind` is the WORST state seen during the incident, never the latest. A
 *      workload that flaps down → unhealthy → down would otherwise re-escalate
 *      every couple of minutes and reproduce exactly the spam the incident record
 *      exists to prevent. The live detail (`reason`, exit code, restart count)
 *      still tracks the present, so the Health tab shows what is happening now
 *      while the severity stays monotonic.
 *   2. Notifications are driven off the transition, not the observation. A
 *      still-broken workload gets `touch()` — which deliberately leaves
 *      `notifyCount`/`notifiedAt` alone.
 *
 * Every notification is preceded by an `audit_event` row and linked to it, so the
 * audit log and the operator's Slack tell the same story.
 */

import {
  repos,
  incidentSeverity,
  type IncidentKind,
  type ServiceIncident,
} from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { notification } from "../../lib/notification-dispatcher";
import { resolveDashboardPublicUrl } from "../../lib/public-url";
import type { WorkloadIncidentKind } from "./steady-state";

/** Incident kind → the audit eventType the notification category is keyed off. */
const EVENT_TYPE: Record<IncidentKind, string> = {
  down: "service.down",
  crash_loop: "service.crash_loop",
  unhealthy: "service.unhealthy",
  server_unreachable: "server.unreachable",
};

/**
 * Incident kind → the bare state, so the sentence supplies its own verb.
 *
 * Deliberately not "is down": every slot but the headline already has a tense of its
 * own ("It was already …", "it was … for 4m"), and a map of predicates dropped into
 * those read "It was already is down for 4m" — on the escalation and the all-clear,
 * which are the two messages an operator reads most carefully.
 */
const STATE: Record<IncidentKind, string> = {
  down: "down",
  crash_loop: "crash looping",
  unhealthy: "unhealthy",
  server_unreachable: "unreachable",
};

/** Where the workload lives — everything an alert needs to name it. */
export interface WorkloadTarget {
  organizationId: string;
  projectId: string;
  projectName: string;
  /** Service row id when the workload is a compose service; null for a single-app deploy. */
  serviceId: string | null;
  /** Dedup identity, stable across a container recreate. See the migration. */
  serviceKey: string;
  serviceName: string;
  serverId: string | null;
  containerId: string | null;
}

/** What one tick observed about a broken workload. */
export interface WorkloadObservation {
  kind: WorkloadIncidentKind;
  reason: string;
  exitCode: number | null;
  restartCount: number;
  oomKilled: boolean;
  /** The container's last log lines. Only worth reading when we will notify. */
  logExcerpt?: string | null;
}

export type IncidentTransition = "opened" | "escalated" | "unchanged";

/**
 * Would recording `kind` against `existing` produce a notification?
 *
 * Exported so the sweep can decide whether to spend an SSH round trip on a log
 * tail BEFORE it calls in: the excerpt is only ever read for a message somebody
 * will actually receive, which keeps a box full of crash-looping containers from
 * costing one `docker logs` per container per minute.
 */
export function willNotifyFor(
  existing: ServiceIncident | undefined | null,
  kind: IncidentKind,
): boolean {
  if (!existing) return true;
  return incidentSeverity(kind) > incidentSeverity(existing.kind as IncidentKind);
}

/** Human downtime — "42s", "7m 12s", "3h 4m", "2d 3h". */
export function formatDowntime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function projectHealthUrl(projectId: string): string {
  return `${resolveDashboardPublicUrl()}/projects/${projectId}/health`;
}

/**
 * Audit + notify for one incident transition.
 *
 * The audit row goes in FIRST and its id rides along on the notification, which is
 * what lets the Settings UI cross-link a delivered message back to the event that
 * caused it. A failed audit insert degrades to an unlinked notification rather
 * than a silent outage.
 */
async function announce(opts: {
  incident: ServiceIncident;
  eventType: string;
  message: string;
  /** Log tail / diagnostic detail — rendered as `Error:` by every channel. */
  detail?: string | null;
  payload?: Record<string, unknown>;
  resourceType: "project" | "server";
  resourceId: string;
}): Promise<void> {
  const auditEventId = await repos.auditEvent
    .create({
      organizationId: opts.incident.organizationId,
      actorUserId: null,
      eventType: opts.eventType,
      resourceType: opts.resourceType,
      resourceId: opts.resourceId,
      source: "system",
      after: {
        incidentId: opts.incident.id,
        kind: opts.incident.kind,
        message: opts.message,
      },
    })
    // null when the org has audit recording switched off — same degradation as a
    // failed insert: the alert still goes out, just without the deep link.
    .then((row) => row?.id)
    .catch((err) => {
      // The alert matters more than its audit cross-link, so this never blocks the
      // notification — it just loses the "view in audit log" deep link. Logged because
      // silently degrading to a linkless alert looked identical to a working one.
      console.error(`[monitoring] audit event for ${opts.eventType} failed: ${safeErrorMessage(err)}`);
      return undefined;
    });

  notification.emit({
    organizationId: opts.incident.organizationId,
    eventType: opts.eventType,
    resourceType: opts.resourceType,
    resourceId: opts.resourceId,
    auditEventId,
    payload: {
      message: opts.message,
      ...(opts.detail ? { errorMessage: opts.detail } : {}),
      incidentId: opts.incident.id,
      ...opts.payload,
    },
  });

  // Swallowed on purpose — the message is already out, and throwing here would make the
  // sweep count a delivered alert as a failure. It is the loudest of these three though:
  // `notifiedAt` is what stops the next tick sending the same alert again, so a write
  // that keeps failing is a re-page every minute with no other symptom.
  await repos.serviceIncident
    .markNotified(opts.incident.id)
    .catch((err) =>
      console.error(
        `[monitoring] incident ${opts.incident.id} notified-marker failed (may re-notify): ${safeErrorMessage(err)}`,
      ),
    );
}

/**
 * Record a failing workload: open an incident, escalate an open one, or just
 * refresh it. Returns which of those happened so the sweep can report counts.
 *
 * `existing` is passed in rather than looked up because the sweep already loaded
 * every open incident for the tick — a healthy instance does no reads here at all.
 */
export async function recordWorkloadFailure(
  target: WorkloadTarget,
  observation: WorkloadObservation,
  existing: ServiceIncident | undefined,
): Promise<IncidentTransition> {
  const detail = {
    reason: observation.reason,
    exitCode: observation.exitCode,
    restartCount: observation.restartCount,
    oomKilled: observation.oomKilled,
    containerId: target.containerId,
  };

  if (!existing) {
    const incident = await repos.serviceIncident.open({
      organizationId: target.organizationId,
      projectId: target.projectId,
      serviceId: target.serviceId,
      serviceKey: target.serviceKey,
      serviceName: target.serviceName,
      serverId: target.serverId,
      kind: observation.kind,
      logExcerpt: observation.logExcerpt ?? null,
      confirmations: 1,
      ...detail,
    });
    // Undefined means the unique index rejected the insert — another tick opened
    // this same incident. Not ours to notify about.
    if (!incident) return "unchanged";
    await announce({
      incident,
      eventType: EVENT_TYPE[observation.kind],
      message: headline(target, observation.kind, observation.reason),
      detail: observation.logExcerpt ?? null,
      resourceType: "project",
      resourceId: target.projectId,
      payload: {
        projectName: target.projectName,
        serviceName: target.serviceName,
        kind: observation.kind,
        exitCode: observation.exitCode,
        restartCount: observation.restartCount,
        oomKilled: observation.oomKilled,
        url: projectHealthUrl(target.projectId),
      },
    });
    return "opened";
  }

  if (willNotifyFor(existing, observation.kind)) {
    const promoted = await repos.serviceIncident.escalate(
      existing.id,
      existing.kind as IncidentKind,
      observation.kind,
      { ...detail, ...(observation.logExcerpt ? { logExcerpt: observation.logExcerpt } : {}) },
    );
    // The row moved under us — another process escalated this same transition, or closed
    // the incident outright. Either way the operator has already heard about it, and a
    // second message is the double page the incident record exists to prevent.
    if (!promoted) return "unchanged";
    await announce({
      incident: { ...existing, kind: observation.kind },
      eventType: EVENT_TYPE[observation.kind],
      message:
        `${headline(target, observation.kind, observation.reason)} ` +
        `It was already ${STATE[existing.kind as IncidentKind]} for ` +
        `${formatDowntime(Date.now() - existing.openedAt.getTime())}.`,
      detail: observation.logExcerpt ?? existing.logExcerpt,
      resourceType: "project",
      resourceId: target.projectId,
      payload: {
        projectName: target.projectName,
        serviceName: target.serviceName,
        kind: observation.kind,
        previousKind: existing.kind,
        exitCode: observation.exitCode,
        restartCount: observation.restartCount,
        oomKilled: observation.oomKilled,
        url: projectHealthUrl(target.projectId),
      },
    });
    return "escalated";
  }

  // Still broken, no worse than before — refresh the detail and stay quiet. This
  // is the branch a multi-hour outage spends every single tick in.
  await repos.serviceIncident.touch(existing.id, detail);
  return "unchanged";
}

/**
 * Close an incident whose workload is healthy again and send the all-clear.
 *
 * The notification fires only when `resolve()` reports it was the one that closed
 * the row, so two overlapping ticks can't both announce a recovery.
 */
export async function resolveWorkloadIncident(
  incident: ServiceIncident,
  projectName: string,
): Promise<boolean> {
  const at = new Date();
  if (!(await repos.serviceIncident.resolve(incident.id, at))) return false;

  const downtime = formatDowntime(at.getTime() - incident.openedAt.getTime());
  await announce({
    incident: { ...incident, status: "resolved", resolvedAt: at },
    eventType: "service.recovered",
    message:
      `"${projectName} / ${incident.serviceName}" is back up — ` +
      `it was ${STATE[incident.kind as IncidentKind]} for ${downtime}.`,
    resourceType: "project",
    resourceId: incident.projectId ?? "",
    payload: {
      projectName,
      serviceName: incident.serviceName,
      kind: incident.kind,
      downtime,
      durationMs: at.getTime() - incident.openedAt.getTime(),
      url: projectHealthUrl(incident.projectId ?? ""),
    },
  });
  return true;
}

/**
 * One box's Docker daemon didn't answer.
 *
 * Recorded as a single SERVER-scoped incident — the alternative (letting each
 * project on the box open its own) turns one unplugged network cable into thirty
 * alerts, which is the loudest possible way to say one thing. Persisted rather
 * than deduped in memory so a box that has been down for three days doesn't
 * re-page every time the control plane restarts.
 */
export async function recordServerUnreachable(opts: {
  organizationId: string;
  serverId: string;
  serverName: string;
  reason: string;
  /** How many projects went unmonitored — the operator's blast radius. */
  affectedProjects: number;
  existing: ServiceIncident | undefined;
}): Promise<IncidentTransition> {
  if (opts.existing) {
    await repos.serviceIncident.touch(opts.existing.id, { reason: opts.reason });
    return "unchanged";
  }

  const incident = await repos.serviceIncident.open({
    organizationId: opts.organizationId,
    projectId: null,
    serviceId: null,
    serviceKey: `server:${opts.serverId}`,
    serviceName: opts.serverName,
    serverId: opts.serverId,
    kind: "server_unreachable",
    reason: opts.reason,
    confirmations: 1,
  });
  if (!incident) return "unchanged";

  const projects =
    opts.affectedProjects === 1 ? "1 project" : `${opts.affectedProjects} projects`;
  await announce({
    incident,
    eventType: "server.unreachable",
    message:
      `Can't reach Docker on server "${opts.serverName}": ${opts.reason}. ` +
      `${projects} on this box can't be monitored until it answers.`,
    resourceType: "server",
    resourceId: opts.serverId,
    payload: {
      serverName: opts.serverName,
      affectedProjects: opts.affectedProjects,
      errorMessage: opts.reason,
    },
  });
  return "opened";
}

/** The box answered again — close its incident and say so. */
export async function resolveServerIncident(incident: ServiceIncident): Promise<boolean> {
  const at = new Date();
  if (!(await repos.serviceIncident.resolve(incident.id, at))) return false;

  const downtime = formatDowntime(at.getTime() - incident.openedAt.getTime());
  await announce({
    incident: { ...incident, status: "resolved", resolvedAt: at },
    eventType: "server.reachable",
    message: `Server "${incident.serviceName}" is answering again after ${downtime}.`,
    resourceType: "server",
    resourceId: incident.serverId ?? "",
    payload: {
      serverName: incident.serviceName,
      downtime,
      durationMs: at.getTime() - incident.openedAt.getTime(),
    },
  });
  return true;
}

function headline(target: WorkloadTarget, kind: IncidentKind, reason: string): string {
  return `"${target.projectName} / ${target.serviceName}" is ${STATE[kind]} — ${reason}.`;
}
