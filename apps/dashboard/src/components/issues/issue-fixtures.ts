import type { IssueCounts, SystemIssue } from "@/lib/api/issues";

/**
 * Fixtures for the issue feed, shared by `/dev/issues`, `/dev/attention` and both
 * render tests. One set, because the home cards render the SAME rows the page does —
 * a second fixture file is how the two surfaces would start disagreeing.
 *
 * Every row here needs real broken infrastructure to reproduce — a crash-looping
 * container, an offline box, an expired certificate — which is exactly why this
 * surface needs fixtures at all: the states worth reviewing are the ones you cannot
 * produce on demand.
 *
 * Field shapes mirror the aggregator's builders exactly, including the parts that
 * read oddly: a component row's `title` is its SERVER (the kind label carries
 * "Edge down"), while an incident's title is the container's own service name, which
 * is why those two differ from their `target.name`.
 *
 * Timestamps are relative to now on purpose. `expiresAt` renders a countdown and a
 * frozen instant would always be in the past, so the "deploy is waiting on you" row
 * would silently lose its deadline line.
 */

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

type Seed = Partial<SystemIssue> & Pick<SystemIssue, "kind" | "severity" | "scope" | "title">;

const mk = (seed: Seed): SystemIssue => ({
  id: `${seed.scope}:${seed.kind}:${seed.title}`,
  source: "incident",
  message: "",
  target: {
    scope: seed.scope,
    id: seed.title,
    name: seed.title,
    href: "#",
    ...seed.target,
  },
  resolveWith: [],
  ...seed,
});

/** One project container failing its health check — the ordinary case. */
const UNHEALTHY = mk({
  kind: "workload_unhealthy",
  severity: "action_required",
  scope: "project",
  source: "incident",
  title: "storefront-web",
  message: "Health check failing for 6 consecutive probes (HTTP 502 on /healthz)",
  since: ago(37),
  target: { scope: "project", id: "p1", name: "storefront", href: "/projects/p1/health" },
});

const CRASH_LOOP = mk({
  kind: "workload_crash_loop",
  severity: "outage",
  scope: "project",
  source: "incident",
  title: "billing-api-worker",
  message: "Restarted 7 times in the last 5 minutes — exited 1: cannot connect to postgres",
  since: ago(9),
  target: { scope: "project", id: "p2", name: "billing-api", href: "/projects/p2/health" },
});

/** The long-error row: what a 320px column has to survive. */
export const EDGE_ERROR =
  "nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use) — the container exited 1";

const EDGE_DOWN = mk({
  kind: "edge_down",
  severity: "outage",
  scope: "server",
  source: "component",
  title: "web-01",
  message: EDGE_ERROR,
  target: { scope: "server", id: "s1", name: "web-01", href: "/servers/s1?tab=components" },
  infraFix: { serverId: "s1", component: "edge", action: "repair" },
});

/** Never installed: a setup gap, so nothing about it may escalate to danger. */
const EDGE_ABSENT = mk({
  kind: "edge_absent",
  severity: "action_required",
  scope: "server",
  source: "component",
  title: "eu-west-3",
  message: "No edge proxy on this server yet — its domains aren't being served",
  target: { scope: "server", id: "s4", name: "eu-west-3", href: "/servers/s4?tab=components" },
  infraFix: { serverId: "s4", component: "edge", action: "repair" },
});

/** Managed image drift: still serving, so advisory — and its fix is `update`. */
const COMPONENT_BEHIND = mk({
  kind: "component_behind",
  severity: "advisory",
  scope: "server",
  source: "component",
  title: "web-02",
  message: "0.4.1 → 0.5.0",
  target: { scope: "server", id: "s5", name: "web-02", href: "/servers/s5?tab=components" },
  infraFix: { serverId: "s5", component: "edge", action: "update" },
});

const SERVER_UNREACHABLE = mk({
  kind: "server_unreachable",
  severity: "outage",
  scope: "server",
  source: "incident",
  title: "eu-west-2",
  message: "SSH connect ETIMEDOUT after 3 attempts",
  since: ago(212),
  target: { scope: "server", id: "s2", name: "eu-west-2", href: "/servers/s2" },
});

const SSL_ERROR = mk({
  kind: "ssl_error",
  severity: "action_required",
  scope: "domain",
  source: "domain",
  title: "shop.example.com",
  message: "Certificate renewal failed: DNS challenge did not propagate within 120s",
  target: { scope: "domain", id: "shop.example.com", name: "shop.example.com", href: "/projects/p1/domains" },
  resolveWith: [{ label: "Retry", method: "POST", path: "/api/domains/d1/ssl" }],
});

const DOMAIN_UNVERIFIED = mk({
  kind: "domain_unverified",
  severity: "action_required",
  scope: "domain",
  source: "domain",
  title: "www.example.com",
  message: "No A record pointing at 203.0.113.10 yet",
  target: { scope: "domain", id: "www.example.com", name: "www.example.com", href: "/projects/p5/domains" },
  resolveWith: [{ label: "Check DNS", method: "POST", path: "/api/domains/d2/verify" }],
});

/** A held deploy: the one row with a deadline, so the countdown line renders. */
const HELD_PROMPT = mk({
  kind: "prompt",
  severity: "action_required",
  scope: "project",
  source: "deploy",
  title: "Volume already exists",
  message: "A volume already exists at /var/lib/postgresql/data — reuse it or start clean?",
  expiresAt: ahead(14),
  target: { scope: "project", id: "p3", name: "analytics", href: "/projects/p3/deployments" },
  resolveWith: [
    { label: "Reuse", method: "POST", path: "/api/deployments/d9/prompt", body: { answer: "reuse" } },
    { label: "Start clean", method: "POST", path: "/api/deployments/d9/prompt", destructive: true },
  ],
});

/**
 * Advisories: listed, never tinted — an update must not look like an outage. The
 * control plane's own row is `platform` scope with NO resolution, which is what makes
 * the row offer the CLI command instead of a button that would 403.
 */
const SELF_UPDATE = mk({
  kind: "update_available",
  severity: "advisory",
  scope: "platform",
  source: "update",
  title: "Openship",
  message: "0.4.1 → 0.5.0",
  target: { scope: "platform", id: "openship", name: "Openship", href: "/settings?tab=instance" },
});

const APP_UPDATE = mk({
  kind: "update_available",
  severity: "advisory",
  scope: "project",
  source: "update",
  title: "plausible",
  message: "v2.0.0 → v2.1.4",
  target: { scope: "project", id: "p4", name: "plausible", href: "/projects/p4" },
  resolveWith: [{ label: "Update", method: "POST", path: "/api/updates/p4/apply" }],
});

const PORT_ADVISORY = mk({
  kind: "port_advisory",
  severity: "advisory",
  scope: "project",
  source: "deploy",
  title: "Published on 3001",
  message: "3000 was already taken by another project on this server",
  target: { scope: "project", id: "p1", name: "storefront", href: "/projects/p1/deployments" },
});

/** Gone rather than stopped: no one-click fix exists, so setup owns the recreate. */
const MAIL_GONE = mk({
  kind: "mail_down",
  severity: "outage",
  scope: "server",
  source: "component",
  title: "mail-01",
  message: "Container not found on the host",
  target: { scope: "server", id: "s3", name: "mail-01", href: "/emails" },
});

export const ISSUE_FIXTURES: Record<string, SystemIssue[]> = {
  /** Mid-incident: something in every scope, worst first. */
  mixed: [
    SELF_UPDATE,
    EDGE_DOWN,
    SERVER_UNREACHABLE,
    CRASH_LOOP,
    UNHEALTHY,
    HELD_PROMPT,
    SSL_ERROR,
    DOMAIN_UNVERIFIED,
    PORT_ADVISORY,
  ],
  /** Everything is down — the page must still be scannable, not a wall of red. */
  outage: [EDGE_DOWN, MAIL_GONE, SERVER_UNREACHABLE, CRASH_LOOP],
  /**
   * Nothing is DOWN, but four things want an answer. Nothing here may render danger:
   * an edge that was never installed and a cert waiting on DNS are setup gaps.
   */
  action: [EDGE_ABSENT, HELD_PROMPT, SSL_ERROR, DOMAIN_UNVERIFIED, UNHEALTHY],
  /** Nothing is broken, only things are behind. No panel should read as an alarm. */
  advisory: [SELF_UPDATE, APP_UPDATE, COMPONENT_BEHIND, PORT_ADVISORY],
  /** A resolved incident: the clock says when it ended, and there is no fix to offer. */
  resolved: [
    { ...CRASH_LOOP, id: "r1", since: ago(180), resolvedAt: ago(140), resolveWith: [] },
    { ...UNHEALTHY, id: "r2", since: ago(600), resolvedAt: ago(520), resolveWith: [] },
  ],
  /** A fleet: 40 rows across 4 scopes, to check density and the group headers. */
  fleet: Array.from({ length: 40 }, (_, i) => {
    const base = [CRASH_LOOP, UNHEALTHY, SSL_ERROR, EDGE_DOWN, APP_UPDATE][i % 5]!;
    return {
      ...base,
      id: `fleet:${i}`,
      title: `${base.title}-${String(i).padStart(2, "0")}`,
      target: { ...base.target, id: `fleet-${i}`, name: `${base.target.name}-${i}` },
    };
  }),
  empty: [],
};

export function countFixtures(issues: SystemIssue[]): IssueCounts {
  return {
    outage: issues.filter((i) => i.severity === "outage").length,
    actionRequired: issues.filter((i) => i.severity === "action_required").length,
    advisory: issues.filter((i) => i.severity === "advisory").length,
    total: issues.length,
  };
}
