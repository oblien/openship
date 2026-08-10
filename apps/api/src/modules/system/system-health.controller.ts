/**
 * GET /api/system/health — internal-token-gated deep health rollup for the CLI
 * `openship doctor`. Distinct from the public `/api/health` liveness stub: this
 * actually probes the database (the CLI can't reach the embedded PGlite itself,
 * it lives inside this API process) and reports instance-wide project/service
 * counts.
 *
 * Live per-container status is gathered CLI-side (it runs on the same machine as
 * the Docker daemon, so a single `docker ps` on the openship labels is cleaner
 * and needs no server-side runtime instantiation). This endpoint is the source
 * of truth for DB health + migration state, and the bare-mode fallback for
 * "how many services are configured".
 *
 * Reachable only when the API is up — which is exactly when the DB is fine. The
 * corruption path (API crash-looping) is handled entirely by the CLI.
 */

import type { Context } from "hono";
import { db, getDriver, sql, count, eq, schema } from "@repo/db";
import { safeErrorMessage } from "@repo/core";

export async function systemHealth(c: Context) {
  const driver = getDriver();

  // ── DB liveness — a trivial round-trip proves the embedded/remote DB answers.
  let dbOk = false;
  let latencyMs: number | null = null;
  let dbError: string | null = null;
  const started = performance.now();
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
    latencyMs = Math.round(performance.now() - started);
  } catch (err) {
    dbError = safeErrorMessage(err);
  }

  // ── Migrations applied (best-effort). drizzle records applied migrations in
  // its own schema; the shape of a raw result differs across drivers, so this is
  // wrapped defensively and degrades to null rather than failing the endpoint.
  let migrationsApplied: number | null = null;
  if (dbOk) {
    try {
      const res: unknown = await db.execute(
        sql`select count(*)::int as n from drizzle."__drizzle_migrations"`,
      );
      const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows) ?? [];
      const n = (rows[0] as { n?: number } | undefined)?.n;
      if (typeof n === "number") migrationsApplied = n;
    } catch {
      /* migrations table absent / driver shape mismatch — leave null */
    }
  }

  // ── Instance-wide project + service counts (schema-safe; no per-status here —
  // the `service` table carries no live status column, that lives on deployment
  // rows and is surfaced live by the CLI via docker ps).
  let projects: { total: number; apps: number } | null = null;
  let servicesConfigured: number | null = null;
  if (dbOk) {
    try {
      const [{ total }] = await db.select({ total: count() }).from(schema.project);
      const [{ apps }] = await db
        .select({ apps: count() })
        .from(schema.project)
        .where(eq(schema.project.isApp, true));
      projects = { total: Number(total), apps: Number(apps) };
    } catch {
      /* best-effort */
    }
    try {
      const [{ total }] = await db.select({ total: count() }).from(schema.service);
      servicesConfigured = Number(total);
    } catch {
      /* best-effort */
    }
  }

  return c.json({
    ok: dbOk,
    db: { driver, ok: dbOk, latencyMs, error: dbError, migrationsApplied },
    projects,
    servicesConfigured,
  });
}
