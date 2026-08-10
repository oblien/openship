/**
 * @module issues
 *
 * "What is wrong across this whole installation right now, and what do I click?"
 *
 * Openship already detected every one of these conditions — it just answered the
 * question one surface at a time. A crash loop lived on its project's Health tab,
 * an unreachable box only ever reached a notification channel, a broken cert sat on
 * a domain row, and edge/mail state made it to the home card. An operator with a
 * dozen boxes had nowhere that listed all of it, which is the difference between
 * "monitoring exists" and "I can see my fleet".
 *
 * So this module adds NO detection. It is a read-only aggregator over five readers
 * that already exist and already own their facts:
 *
 *   repos.serviceIncident.listByOrg   workload + server incidents (the only source
 *                                     with a lifecycle, so the only one with history)
 *   loadOrgContainerIssues            edge / mail component state (cached rows)
 *   getOrgPendingActions              deploy / routing / port / domain / SSL
 *   listOrganizationUpdates           project version drift (advisory)
 *   listBehindByOrg                   managed edge/mail image drift (advisory)
 *
 * The rules that keep it from becoming a fifth source of truth:
 *   - it never writes, never probes, and never re-implements a verdict. Freshness
 *     is each source's own business — `listOrganizationUpdates` polls what its
 *     cache can't answer, precisely so this module never has to ask whether the
 *     row it just read was real.
 *   - severity is defined ONCE, in `SEVERITY_RANK` below. Pending actions map their
 *     existing tier straight through rather than being re-judged.
 *   - every item carries its fix as data — `resolveWith` (an HTTP call) for
 *     project/domain items, `infraFix` (a modal flow) for managed containers —
 *     so no caller has to know which endpoint answers which condition.
 */

import {
  repos,
  type IncidentKind,
  type ServerContainerStatus,
  type ServiceIncident,
} from "@repo/db";
import { env } from "../../config/env";
import type { RequestContext } from "../../lib/request-context";
import { checkPermissionOnResource } from "../../lib/permission";
import {
  getOrgPendingActions,
  type PendingAction,
  type PendingActionKind,
  type PendingActionResolution,
} from "../projects/pending-actions.service";
import {
  loadOrgContainerIssues,
  type ContainerIssue,
} from "../system/server-containers.service";
import { listOrganizationUpdates } from "../updates/updates.service";

// ─── Shape ──────────────────────────────────────────────────────────────────

/**
 * What an issue is ABOUT — and therefore where it groups and who fixes it.
 * Exactly one level: an issue belongs to one target, and the target is the thing
 * an operator acts on. Nothing nests.
 */
export type IssueScope = "platform" | "server" | "project" | "domain";

/**
 * `outage` — not being served right now. The one tier `PendingAction` has no
 *   concept of, because nothing it describes takes an app offline.
 * `action_required` — someone must act or this stays broken.
 * `advisory` — probably worth knowing, safe to ignore.
 */
export type IssueSeverity = "outage" | "action_required" | "advisory";

export type IssueSource = "incident" | "component" | "deploy" | "domain" | "update";

/**
 * Closed union so the dashboard can map kind → label/icon exhaustively instead of
 * string-matching. The first group is `PendingActionKind` verbatim (same builders,
 * same names); the rest name conditions the other three sources report.
 */
export type IssueKind =
  | PendingActionKind
  | "workload_unhealthy"
  | "workload_crash_loop"
  | "workload_down"
  | "server_unreachable"
  | "edge_down"
  | "edge_absent"
  | "mail_down"
  | "update_available"
  | "component_behind";

/** A managed container's fix is a streamed modal flow, not an HTTP call — see `useInfraFix`. */
export interface InfraFix {
  serverId: string;
  component: "edge" | "mail";
  /** `repair` brings a stopped component back; `update` swaps onto the pinned image. */
  action: "repair" | "update";
}

export interface SystemIssue {
  /** Stable for the same underlying condition, so a client can de-dupe across polls. */
  id: string;
  kind: IssueKind;
  severity: IssueSeverity;
  scope: IssueScope;
  source: IssueSource;
  title: string;
  message: string;
  details?: Record<string, unknown>;
  /** Only on `prompt`: when the hold gives up and the deploy aborts. */
  expiresAt?: string;
  /**
   * When the condition STARTED. Only incidents record this — they're the one source
   * with an open/resolve lifecycle. Absent elsewhere on purpose rather than filled
   * with a "last checked" timestamp, which would read as a downtime clock and be
   * wrong by however long the checker has been running.
   */
  since?: string;
  /** Set only on resolved incidents (the Resolved tab). */
  resolvedAt?: string;
  target: { scope: IssueScope; id: string; name: string; href: string };
  /** Callable as-is, params already substituted. Empty when the fix is `infraFix`. */
  resolveWith: PendingActionResolution[];
  infraFix?: InfraFix;
}

export interface IssueCounts {
  outage: number;
  actionRequired: number;
  advisory: number;
  total: number;
}

/**
 * The ONE severity ordering. `bySeverity` (pending-actions) and `incidentSeverity`
 * (the incident repo) keep serving their own callers — the point is that this
 * module doesn't derive a third; it maps into this one.
 */
const SEVERITY_RANK: Record<IssueSeverity, number> = {
  outage: 0,
  action_required: 1,
  advisory: 2,
};

/** Worst first; within a tier, whatever order the sources were merged in. */
function bySeverity(a: SystemIssue, b: SystemIssue): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
}

export function countIssues(issues: SystemIssue[]): IssueCounts {
  return {
    outage: issues.filter((i) => i.severity === "outage").length,
    actionRequired: issues.filter((i) => i.severity === "action_required").length,
    advisory: issues.filter((i) => i.severity === "advisory").length,
    total: issues.length,
  };
}

// ─── Source: incidents ──────────────────────────────────────────────────────

/**
 * Incident kind → the tracker's tier. `unhealthy` is deliberately NOT an outage:
 * a failing healthcheck on a container that is still up and answering is a
 * degradation, and calling it an outage is how an outage list stops being read.
 */
const INCIDENT_KIND: Record<IncidentKind, { kind: IssueKind; severity: IssueSeverity }> = {
  unhealthy: { kind: "workload_unhealthy", severity: "action_required" },
  crash_loop: { kind: "workload_crash_loop", severity: "outage" },
  down: { kind: "workload_down", severity: "outage" },
  server_unreachable: { kind: "server_unreachable", severity: "outage" },
};

function incidentIssue(
  row: ServiceIncident,
  names: { project: Map<string, string>; server: Map<string, string> },
): SystemIssue {
  const map = INCIDENT_KIND[row.kind] ?? INCIDENT_KIND.down;
  // A server-scoped row has no project BY DESIGN — an unreachable box is one
  // incident, not one per workload on it. That's also what decides the target here.
  const serverScoped = !row.projectId;
  const target = serverScoped
    ? {
        scope: "server" as const,
        id: row.serverId ?? row.serviceKey,
        name: names.server.get(row.serverId ?? "") ?? row.serviceName,
        href: row.serverId ? `/servers/${row.serverId}` : "/servers",
      }
    : {
        scope: "project" as const,
        id: row.projectId!,
        name: names.project.get(row.projectId!) ?? row.serviceName,
        href: `/projects/${row.projectId}/health`,
      };

  return {
    id: `incident:${row.id}`,
    kind: map.kind,
    severity: map.severity,
    scope: target.scope,
    source: "incident",
    // Snapshotted at incident time on purpose — a later rename must not rewrite
    // what the alert said.
    title: row.serviceName,
    message: row.reason ?? "",
    details: {
      incidentKind: row.kind,
      serviceKey: row.serviceKey,
      exitCode: row.exitCode,
      restartCount: row.restartCount,
      oomKilled: row.oomKilled,
      confirmations: row.confirmations,
      logExcerpt: row.logExcerpt,
    },
    since: row.openedAt.toISOString(),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.toISOString() } : {}),
    target,
    // Recovery is the workload's own surface (redeploy / restart / fix the box) —
    // there is no single call that resolves an incident, and offering one would be
    // pretending. The row links to the Health tab that owns it.
    resolveWith: [],
  };
}

// ─── Source: managed components ─────────────────────────────────────────────

function componentIssue(issue: ContainerIssue): SystemIssue {
  const isMail = issue.component === "mail";
  const down = issue.issue === "down";
  const kind: IssueKind = isMail ? "mail_down" : down ? "edge_down" : "edge_absent";
  // A GONE mail container has no fix here: recreating it needs the secrets only the
  // mail-setup wizard holds, so the row points at setup rather than offering an
  // action that would clobber a live mailbox. Same rule the home card enforces.
  const mailGone = isMail && issue.containerMissing;

  return {
    id: `component:${issue.server.id}:${issue.component}`,
    kind,
    // An edge that was never installed is a setup gap, not an outage — a box that
    // has projects but no edge isn't serving them yet, it was never set up to.
    severity: down ? "outage" : "action_required",
    scope: "server",
    source: "component",
    title: issue.server.name,
    message: issue.reason ?? "",
    details: { component: issue.component, issue: issue.issue, containerMissing: issue.containerMissing },
    target: {
      scope: "server",
      id: issue.server.id,
      name: issue.server.name,
      href: mailGone ? "/emails" : `/servers/${issue.server.id}?tab=components`,
    },
    resolveWith: [],
    ...(mailGone
      ? {}
      : { infraFix: { serverId: issue.server.id, component: issue.component, action: "repair" as const } }),
  };
}

/**
 * A managed container running an older image than the control plane pins.
 *
 * The home card showed this as one aggregate line ("2 servers behind"); as a feed
 * row it names the component, which is what makes it actionable — and it reuses the
 * same `infraFix` dispatcher as the down rows, just with `update` instead of
 * `repair`. Advisory: a behind edge is still serving traffic.
 */
function componentBehindIssue(
  row: ServerContainerStatus,
  names: { server: Map<string, string> },
): SystemIssue {
  const serverName = names.server.get(row.serverId) ?? row.serverId;
  const version =
    row.runningVersion && row.pinnedVersion
      ? `${row.runningVersion} → ${row.pinnedVersion}`
      : (row.pinnedVersion ?? "");

  return {
    id: `behind:${row.serverId}:${row.component}`,
    kind: "component_behind",
    severity: "advisory",
    scope: "server",
    source: "component",
    title: serverName,
    message: version,
    details: {
      component: row.component,
      runningVersion: row.runningVersion,
      pinnedVersion: row.pinnedVersion,
      latestInProgress: row.latestInProgress,
    },
    target: {
      scope: "server",
      id: row.serverId,
      name: serverName,
      href: `/servers/${row.serverId}?tab=components`,
    },
    resolveWith: [],
    infraFix: { serverId: row.serverId, component: row.component, action: "update" },
  };
}

// ─── Source: pending actions ────────────────────────────────────────────────

/** Which project tab owns each pending-action kind's fix. */
const PENDING_TAB: Record<PendingActionKind, string> = {
  deploy_blocked: "deployments",
  prompt: "deployments",
  partial_decision: "deployments",
  port_advisory: "deployments",
  routing_unsynced: "domains",
  domain_unverified: "domains",
  ssl_error: "domains",
};

const DOMAIN_KINDS = new Set<PendingActionKind>(["domain_unverified", "ssl_error"]);

function pendingIssue(
  action: PendingAction,
  project: { id: string; name: string },
): SystemIssue {
  // A domain problem is about a hostname, not the project that happens to own it —
  // an operator with 40 domains scans for the hostname. The target still links to
  // the project's Domains tab, which is where the fix lives.
  const isDomain = DOMAIN_KINDS.has(action.kind);
  const hostname = typeof action.details?.hostname === "string" ? action.details.hostname : null;
  const scope: IssueScope = isDomain ? "domain" : "project";

  return {
    id: action.id,
    kind: action.kind,
    // Straight passthrough — the builders already decided which of these is a
    // blocker and which is a hint, and re-judging it here is how two surfaces
    // start disagreeing about the same row.
    severity: action.severity === "advisory" ? "advisory" : "action_required",
    scope,
    source: isDomain ? "domain" : "deploy",
    title: action.title,
    message: action.message,
    ...(action.details ? { details: action.details } : {}),
    ...(action.expiresAt ? { expiresAt: action.expiresAt } : {}),
    target: {
      scope,
      id: isDomain && hostname ? hostname : project.id,
      name: isDomain && hostname ? hostname : project.name,
      href: `/projects/${project.id}/${PENDING_TAB[action.kind] ?? "overview"}`,
    },
    resolveWith: action.resolveWith,
  };
}

// ─── Source: version drift ──────────────────────────────────────────────────

type UpdateRow = Awaited<ReturnType<typeof listOrganizationUpdates>>[number];

function updateIssue(row: UpdateRow): SystemIssue {
  // The control plane reports its own drift here, but it upgrades itself through
  // the CLI (`build.service` refuses to redeploy it), so it is a PLATFORM issue
  // with no in-app fix rather than a project row with a button that 403s.
  const isSelf = row.appTemplateId === "openship";
  const version =
    row.currentLabel && row.latestLabel
      ? `${row.currentLabel} → ${row.latestLabel}`
      : (row.latestLabel ?? "");

  return {
    id: `update:${row.projectId}`,
    kind: "update_available",
    severity: "advisory",
    scope: isSelf ? "platform" : "project",
    source: "update",
    title: row.name,
    message: version,
    details: {
      kind: row.kind,
      currentLabel: row.currentLabel,
      latestLabel: row.latestLabel,
      latestInProgress: row.latestInProgress,
      selfUpdate: isSelf,
    },
    target: {
      scope: isSelf ? "platform" : "project",
      id: row.projectId,
      name: row.name,
      // Where the CLI command actually lives (`UpdatesTab`), not the project page
      // whose Update button would 403.
      href: isSelf ? "/settings?tab=instance" : `/projects/${row.projectId}`,
    },
    resolveWith: isSelf
      ? []
      : [{ label: "Update", method: "POST", path: `/api/updates/${row.projectId}/apply` }],
  };
}

// ─── Aggregation ────────────────────────────────────────────────────────────

/**
 * Infrastructure sources (incidents, managed components) are self-hosted concepts
 * AND server-permission territory. Both gates mirror what the existing endpoints
 * already enforce rather than inventing policy: `/containers/issues` is
 * `server:read` + `assertNotCloud`, and today the home card simply swallows its 403.
 * Here that becomes explicit — a member without server access gets the deploy,
 * domain and update rows and no hint that servers exist.
 */
async function canSeeInfra(ctx: RequestContext): Promise<boolean> {
  if (env.CLOUD_MODE) return false;
  return checkPermissionOnResource(ctx, {
    resourceType: "server",
    resourceId: "*",
    action: "read",
    scope: "list",
  });
}

/**
 * Every open issue in the caller's organization, worst first.
 *
 * `status: "resolved"` returns incident HISTORY only, because incidents are the
 * only source with a lifecycle — a cert that got fixed leaves no "resolved cert
 * problem" row anywhere, it just stops being a problem. The UI says so rather than
 * implying the tab is a complete audit of everything that ever broke.
 */
export async function listOrganizationIssues(
  ctx: RequestContext,
  opts: { status?: "open" | "resolved" } = {},
): Promise<{ issues: SystemIssue[]; counts: IssueCounts }> {
  const organizationId = ctx.organizationId;
  const status = opts.status ?? "open";
  const infra = await canSeeInfra(ctx);

  if (status === "resolved") {
    if (!infra) return { issues: [], counts: countIssues([]) };
    const [rows, names] = await Promise.all([
      repos.serviceIncident.listByOrg(organizationId, { status: "resolved" }),
      loadNames(organizationId),
    ]);
    const issues = rows.map((r) => incidentIssue(r, names));
    return { issues, counts: countIssues(issues) };
  }

  const [incidents, components, behind, pending, updates, names] = await Promise.all([
    infra
      ? repos.serviceIncident.listByOrg(organizationId, { status: "open" }).catch(() => [])
      : Promise.resolve([]),
    infra ? loadOrgContainerIssues(organizationId).catch(() => null) : Promise.resolve(null),
    infra
      ? repos.serverContainerStatus.listBehindByOrg(organizationId).catch(() => [])
      : Promise.resolve([]),
    getOrgPendingActions(organizationId).catch(() => new Map<string, PendingAction[]>()),
    listOrganizationUpdates(ctx, { behindOnly: true }).catch(() => []),
    loadNames(organizationId),
  ]);

  const issues: SystemIssue[] = [];

  // Worst-first at the source level too, so the merge order matches the tiers and
  // ties inside a tier stay stable across polls.
  for (const row of incidents) issues.push(incidentIssue(row, names));

  // A box we cannot reach tells us NOTHING about the containers on it — the cached
  // edge/mail rows are just the last thing we saw. Reporting "edge down" next to
  // "server unreachable" is two rows for one cause, and the box is the actionable
  // one, so its components are suppressed while it's unreachable.
  const unreachable = new Set(
    incidents.filter((r) => r.kind === "server_unreachable" && r.serverId).map((r) => r.serverId!),
  );
  const broken = new Set<string>();
  for (const issue of components?.servers ?? []) {
    if (unreachable.has(issue.server.id)) continue;
    broken.add(`${issue.server.id}:${issue.component}`);
    issues.push(componentIssue(issue));
  }

  // Drift on a component that is already down is not a second thing to tell the
  // operator — "an update is available" for a container that isn't running is noise
  // under the row that says it isn't running.
  for (const row of behind) {
    if (unreachable.has(row.serverId)) continue;
    if (broken.has(`${row.serverId}:${row.component}`)) continue;
    issues.push(componentBehindIssue(row, names));
  }

  for (const [projectId, actions] of pending) {
    const name = names.project.get(projectId) ?? projectId;
    for (const action of actions) issues.push(pendingIssue(action, { id: projectId, name }));
  }

  for (const row of updates) {
    if (!row.behind) continue;
    // Already deploying the newest version — there is nothing left to act on, and
    // an "Update" button here is what made pressing it look like it did nothing.
    if (row.latestInProgress) continue;
    issues.push(updateIssue(row));
  }

  issues.sort(bySeverity);
  return { issues, counts: countIssues(issues) };
}

/**
 * Display names for the two things an issue can target. Snapshotted incident names
 * are used as the fallback, so a deleted project still reads as something.
 */
async function loadNames(organizationId: string) {
  const [projects, servers] = await Promise.all([
    repos.project
      .listByOrganization(organizationId, { perPage: 1000 })
      .then((r) => r.rows)
      .catch(() => []),
    repos.server.listByOrganization(organizationId).catch(() => []),
  ]);
  return {
    project: new Map(projects.map((p) => [p.id, p.name])),
    server: new Map(servers.map((s) => [s.id, s.name ?? s.sshHost])),
  };
}
