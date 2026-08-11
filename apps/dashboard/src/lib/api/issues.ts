import { api } from "./client";
import { endpoints } from "./endpoints";

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
  | "domain_unverified"
  | "ssl_error"
  | "port_advisory"
  // Container health incidents
  | "workload_unhealthy"
  | "workload_crash_loop"
  | "workload_down"
  | "server_unreachable"
  // Managed components
  | "edge_down"
  | "edge_absent"
  | "mail_down"
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
}

export interface RescanResult {
  ran: string[];
  skipped: string[];
  failed: Array<{ key: string; error: string }>;
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
  /** Open issues (default) or resolved incident history. */
  list: (status: "open" | "resolved" = "open") =>
    api.get<IssueFeed>(status === "resolved" ? endpoints.issues.resolved : endpoints.issues.open),

  // `GET /issues/summary` (counts without rows) has no client wrapper on purpose: the
  // page reads its counts off the feed it already fetched, and the nav entry carries no
  // badge. It stays a server endpoint for MCP clients asking "is anything broken".

  /** Run the scheduled checkers behind the feed now. Self-hosted only (404s on cloud). */
  rescan: () => api.post<{ data: RescanResult }>(endpoints.issues.rescan),
};
