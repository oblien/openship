import { api, getActiveOrganizationId } from "./client";
import { endpoints } from "./endpoints";

/** Connection failures describe unavailable observations, not confirmed outages. */
export function isMonitoringConnectionIssue(issue: Pick<SystemIssue, "kind">): boolean {
  return issue.kind === "monitoring_offline" || issue.kind === "server_unreachable";
}

/**
 * The org-wide issue feed — the client half of `apps/api/src/modules/issues`.
 *
 * These types MIRROR the server's `SystemIssue` deliberately rather than being
 * re-derived from the sources: the whole point of the endpoint is that severity,
 * grouping and remediation are decided once, server-side. If a field looks like it
 * wants computing here, it belongs in the aggregator instead.
 */

export type IssueScope = "platform" | "server" | "project" | "domain";
export type IssueSeverity = "outage" | "action_required" | "advisory";
export type IssueSource = "incident" | "component" | "deploy" | "domain" | "update";

export type IssueKind =
  // Pending actions (deploy / routing / domain)
  | "deploy_blocked"
  | "prompt"
  | "partial_decision"
  | "routing_unsynced"
  | "restart_loop"
  | "domain_unverified"
  | "ssl_error"
  | "port_advisory"
  // Container health incidents
  | "workload_unhealthy"
  | "workload_crash_loop"
  | "workload_down"
  | "server_unreachable"
  | "monitoring_offline"
  // Managed components
  | "edge_down"
  | "edge_absent"
  | "mail_down"
  | "mail_certificate"
  // Version drift
  | "update_available"
  | "component_behind";

/** A concrete call that fixes the issue — path already substituted. */
export interface IssueResolution {
  label: string;
  destructive?: boolean;
  method: "POST" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}

/** A managed container's fix is a streamed modal flow — hand it to `useInfraFix`. */
export interface IssueInfraFix {
  serverId: string;
  component: "edge" | "mail";
  action: "repair" | "update";
}

export interface SystemIssue {
  id: string;
  kind: IssueKind;
  severity: IssueSeverity;
  scope: IssueScope;
  source: IssueSource;
  title: string;
  message: string;
  details?: Record<string, unknown>;
  expiresAt?: string;
  /** Only incidents carry this — see the server's note on why nothing else does. */
  since?: string;
  resolvedAt?: string;
  target: { scope: IssueScope; id: string; name: string; href: string };
  resolveWith: IssueResolution[];
  infraFix?: IssueInfraFix;
}

/** The saved deployment owns progress across navigation and page refreshes. */
export function issueDeploymentId(issue: SystemIssue): string | null {
  const id = issue.details?.inProgressDeploymentId;
  return issue.kind === "update_available" && typeof id === "string" && id ? id : null;
}

export function issueUpdateInProgress(issue: SystemIssue): boolean {
  return !!issueDeploymentId(issue) ||
    (issue.kind === "update_available" && issue.details?.latestInProgress === true);
}

export interface IssueCounts {
  outage: number;
  actionRequired: number;
  advisory: number;
  total: number;
}

export interface IssueFeed {
  data: SystemIssue[];
  counts: IssueCounts;
  status: "open" | "resolved";
  canClearHistory?: boolean;
}

type IssueCountsListener = (counts: IssueCounts, organizationId: string | null) => void;
const countsListeners = new Set<IssueCountsListener>();

/** Share Home/Monitoring refreshes with the sidebar, including after a fix. */
export function subscribeOpenIssueCounts(listener: IssueCountsListener): () => void {
  countsListeners.add(listener);
  return () => {
    countsListeners.delete(listener);
  };
}

export interface RescanResult {
  ran: string[];
  skipped: string[];
  failed: Array<{ key: string; error: string }>;
}

export interface MonitoringScanStage {
  key: "services:health-watch" | "infra:scan" | "domains:verify-pending" | "updates:scan";
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  summary?: Record<string, unknown>;
  error?: string;
}

export interface MonitoringScanSession {
  id: string;
  status: "running" | "completed";
  startedAt: string;
  finishedAt?: string;
  stages: MonitoringScanStage[];
}

export interface WorkloadHealthRow {
  projectId: string;
  projectName: string;
  projectSlug: string;
  serviceId: string | null;
  serviceKey: string;
  serviceName: string;
  serverId: string | null;
  serverName: string;
  containerId: string;
  state: "healthy" | "down" | "crash_loop" | "unhealthy" | "unknown";
  observedAt: string;
}

export interface HealthCheckSummary {
  servers: number;
  projects: number;
  workloads: number;
  opened: number;
  escalated: number;
  resolved: number;
  stale: number;
  unreachable: number;
  /** Missing on APIs predating desktop connectivity detection. */
  offline?: number;
  unresolved: number;
  skipped: number;
  indeterminate: number;
  pending: number;
  recovering: number;
  errors: number;
}

export interface CurrentHealthScanResult {
  completedAt: string;
  summary: HealthCheckSummary;
}

export interface MonitoringHealthSnapshot {
  data: WorkloadHealthRow[];
  watching: boolean;
  capabilities: { current: boolean; continuous: boolean };
  currentScan: CurrentHealthScanResult | null;
  watcher: {
    key: string;
    schedule: string | null;
    available: boolean;
    eventsEnabled: boolean;
    canManage: boolean;
    runsWhileAppOpen: boolean;
  };
}

/**
 * Run an item's carried fix.
 *
 * `resolveWith.path` is a FULL api path (`/api/domains/x/verify`) because the same
 * items are served to MCP clients that call the API directly. This client is already
 * based at `<origin>/api/`, so the prefix comes off exactly once — done here rather
 * than in each caller, since that off-by-one is invisible until a fix 404s.
 */
export function runResolution(r: IssueResolution) {
  const path = r.path.replace(/^\/?api\//, "");
  return r.method === "DELETE" ? api.delete(path) : api.post(path, r.body);
}

export const issuesApi = {
  clearHistory: () => api.delete<{ data: { deleted: number } }>(endpoints.issues.clearHistory),
  /** Open issues (default) or resolved incident history. */
  list: async (status: "open" | "resolved" = "open") => {
    const organizationId = getActiveOrganizationId();
    const feed = await api.get<IssueFeed>(
      status === "resolved" ? endpoints.issues.resolved : endpoints.issues.open,
    );
    if (status === "open" && feed.counts && organizationId === getActiveOrganizationId()) {
      countsListeners.forEach((listener) => listener(feed.counts, organizationId));
    }
    return feed;
  },

  /** The same open-feed counts, without transferring every issue row. */
  summary: () => api.get<{ data: IssueCounts }>(endpoints.issues.summary, { dedupe: false }),

  /** Cached output of the grouped Docker watcher; does not probe containers. */
  health: () =>
    api.get<MonitoringHealthSnapshot>(endpoints.issues.health, { dedupe: false }),

  /** One current-state pass. Shares the watcher scanner but no watcher side effects. */
  scanHealth: () =>
    api.post<{ data: CurrentHealthScanResult }>(endpoints.issues.healthScan, undefined, {
      timeout: 300_000,
    }),

  /** Run the scheduled checkers behind the feed now. Self-hosted only (404s on cloud). */
  rescan: (options?: { healthOnly?: boolean }) => api.post<{ data: MonitoringScanSession }>(endpoints.issues.rescan, options),
  rescanStatus: () => api.get<{ data: MonitoringScanSession | null }>(endpoints.issues.rescanStatus, { dedupe: false }),
};
