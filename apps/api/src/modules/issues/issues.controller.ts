/**
 * Issues HTTP handlers — the org-wide "what is broken" surface.
 *
 * Three handlers, all thin: the aggregator owns every decision (which sources the
 * caller may see, how severity ranks, what the fix is), so these only parse a query
 * param and shape the envelope. Rescan is the one that acts, and it acts by firing
 * jobs that already exist rather than probing anything itself.
 */

import type { Context } from "hono";
import { getRequestContext } from "../../lib/request-context";
import { SYSTEM_JOB_BY_KEY } from "../jobs/job.registry";
import { runJobNow } from "../jobs/job.service";
import { listOrganizationIssues } from "./issues.service";

/** GET /api/issues?status=open|resolved — every issue in the caller's org. */
export async function listIssues(c: Context) {
  const ctx = getRequestContext(c);
  const status = c.req.query("status") === "resolved" ? "resolved" : "open";
  const { issues, counts } = await listOrganizationIssues(ctx, { status });
  return c.json({ data: issues, counts, status });
}

/**
 * GET /api/issues/summary — counts without rows.
 *
 * For callers that only need the tally: MCP clients answering "is anything broken",
 * and any future badge. The dashboard reads its counts off the feed it already
 * fetched, so nothing in the UI calls this today.
 *
 * Re-runs the same aggregator instead of counting a cheaper way: a number that
 * disagrees with the page it summarizes is worse than a slightly more expensive read,
 * and every source here is a cached DB read.
 */
export async function issuesSummary(c: Context) {
  const ctx = getRequestContext(c);
  const { counts } = await listOrganizationIssues(ctx);
  return c.json({ data: counts });
}

/**
 * The checkers whose caches back this feed. Deliberately the SCHEDULED jobs, not
 * the underlying services — "re-scan" means "run the sweep early", so the run shows
 * up in the jobs history with a `manual` trigger like any other run-now.
 *
 * Ordered cheapest-first only for tidiness; they run concurrently.
 */
const RESCAN_JOBS = [
  "services:health-watch",
  "infra:scan",
  "domains:verify-pending",
  "updates:scan",
] as const;

/**
 * POST /api/issues/rescan — refresh every source behind the feed.
 *
 * A job whose platform gate is false was never seeded (see `reconcileJobs`), so it
 * is reported as `skipped` rather than failing the request: on desktop there is no
 * health watch to run, and asking for a fleet re-scan there shouldn't 404.
 *
 * Reports per-job outcomes instead of a bare ok — a scan that silently didn't run
 * is indistinguishable from "nothing is wrong", which is the failure mode this
 * whole surface exists to prevent.
 */
export async function rescanIssues(c: Context) {
  // Cloud is refused by the route's `localOnly` — the same gate the jobs module
  // puts on its own run-now, rather than a second cloud check here.
  const available = RESCAN_JOBS.filter((key) => {
    const def = SYSTEM_JOB_BY_KEY.get(key);
    return !def?.available || def.available();
  });
  const skipped = RESCAN_JOBS.filter((key) => !available.includes(key));

  const settled = await Promise.allSettled(available.map((key) => runJobNow(key)));
  const ran: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];
  settled.forEach((result, i) => {
    const key = available[i]!;
    if (result.status === "fulfilled") ran.push(key);
    else failed.push({ key, error: (result.reason as Error)?.message ?? "failed" });
  });

  c.set("auditAfter", { ran, skipped, failed: failed.map((f) => f.key) });
  return c.json({ data: { ran, skipped, failed } });
}
