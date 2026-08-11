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
 * of truth for DB health + migration state, the bare-mode fallback for "how many
 * services are configured", and — over HTTP, from anywhere — whether this
 * instance can drive its own host.
 *
 * Reachable only when the API is up — which is exactly when the DB is fine. The
 * corruption path (API crash-looping) is handled entirely by the CLI.
 */

import type { Context } from "hono";
import { db, getDriver, sql, count, eq, schema } from "@repo/db";
import { hostChannelHealth, type HostChannelHealth } from "@repo/adapters";
import { HOST_CHANNEL_NOT_PROVISIONED, safeErrorMessage } from "@repo/core";

import { env } from "../../config";

/**
 * The container→host SSH channel, as a monitor can see it (#509).
 *
 * Every other surface that reports this channel is LOCAL — the boot banner, the
 * `openship doctor` rows, the dashboard's server list. So on the box #509 describes,
 * host execution was unobservable over HTTP: the install said success, the rollup said
 * healthy, and the first host operation failed with text naming `openship doctor` as
 * the way to check. This is that check, on the endpoint doctor already calls.
 *
 * Deliberately narrower than {@link HostChannelHealth}:
 *   - the key path and the firewall rule NEVER go on the wire. A rule is a block of
 *     pasteable sudo commands scoped to this box's bridge CIDR; it belongs on the
 *     surfaces an operator is standing at (banner, doctor), not in a monitoring payload.
 *   - no `target`/`host`/`port` fields either: nothing should branch on the endpoint,
 *     and an address in a structured field reads as "we dialed this", which for an
 *     unprovisioned channel is exactly the false claim #509 made in the dashboard. The
 *     `remedy` prose still names it where a dial really happened, verbatim from the
 *     shared copy so it can't drift from what the other surfaces print.
 *   - `cause` is kept: it classifies the fault (dropped / refused / didn't resolve)
 *     without naming an address, which is what an alert rule wants to branch on.
 * `state` is `hostChannelHealth`'s own code, passed through rather than re-mapped —
 * a second vocabulary for the same states is how these surfaces drifted before.
 */
interface HostChannelReport {
  /** Host ("this machine") operations can be performed at all. */
  ok: boolean;
  state: HostChannelHealth["code"];
  cause?: HostChannelHealth["cause"];
  /** What to do about it, when there is something to do. */
  remedy?: string;
}

function reportHostChannel(h: HostChannelHealth): HostChannelReport {
  return {
    ok: h.ok,
    state: h.code,
    ...(h.cause ? { cause: h.cause } : {}),
    // `key_unreadable`'s own hint names the key PATH, which never goes on the wire —
    // and the remedy is the same one anyway: reprovision, then verify.
    ...(h.code === "key_unreadable"
      ? { remedy: HOST_CHANNEL_NOT_PROVISIONED }
      : h.hint
        ? { remedy: h.hint }
        : {}),
  };
}

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

  // ── Can this instance drive its own host? Best-effort, like every other section
  // here: a probe that couldn't RUN reports `null`, never a verdict about the host.
  // Kept OUT of the top-level `ok`, which means "the database answers" — a box with
  // no host channel is degraded, not down (HOST_CHANNEL_UNAFFECTED), and folding it
  // in would make `openship doctor --fix` reach for the database repair.
  let hostChannel: HostChannelReport | null = null;
  // On the SaaS control plane there is no host to drive. `hostChannelHealth` already
  // returns before any key read when OPENSHIP_HOST_SSH_HOST is unset — which it is on
  // the SaaS — but gate on CLOUD_MODE explicitly so this endpoint can never call
  // readFileSync on a host key path, rather than relying on that env staying absent.
  if (!env.CLOUD_MODE) {
    try {
      hostChannel = reportHostChannel(await hostChannelHealth());
    } catch {
      /* diagnostic failed — say nothing rather than blame the host */
    }
  }

  return c.json({
    ok: dbOk,
    db: { driver, ok: dbOk, latencyMs, error: dbError, migrationsApplied },
    projects,
    servicesConfigured,
    hostChannel,
  });
}
