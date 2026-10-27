import {
  diagnostics,
  errorReporter,
  type ErrorEvent,
  type ErrorSink,
} from "@repo/core/diagnostics";
import { writableErrorSink } from "@repo/core/diagnostics/node";
import { sql, type Database, type DatabaseTransaction, type Driver } from "@repo/db/factory";

// Temporary Cloud-owned storage, deliberately outside shared schema migrations.
// No second queue: the shared reporter already batches, bounds and redacts events.
const RETENTION_DAYS = 30;
const PRUNE_BATCH = 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

async function boundedTransaction<T>(
  db: Database,
  run: (tx: DatabaseTransaction) => Promise<T>,
  phase: "startup" | "delivery" = "delivery",
): Promise<T> {
  return db.transaction(async (tx) => {
    // These never leak into application queries on the pooled connection.
    // Schema setup also waits behind other replicas' DDL. The short best-effort
    // delivery deadline must not permanently disable storage during a rollout.
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${phase === "startup" ? "5s" : "250ms"}, true)`,
    );
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${phase === "startup" ? "10s" : "500ms"}, true)`,
    );
    return run(tx);
  });
}

function eventJson(event: ErrorEvent): string {
  // PostgreSQL jsonb rejects NUL and lone UTF-16 surrogates. A truncated error
  // (for example halfway through an emoji) must not poison the entire batch.
  return JSON.stringify(event, (_key, value) =>
    typeof value === "string" ? Buffer.from(value.replace(/\u0000/g, "")).toString("utf8") : value,
  );
}

/** Only installCloudErrorDestination calls this in product code. */
export async function createCloudErrorSink(db: Database, driver: Driver): Promise<ErrorSink> {
  await boundedTransaction(
    db,
    async (tx) => {
      // IF NOT EXISTS alone does not serialize concurrent PostgreSQL DDL. PGlite
      // has one connection and already serializes its transactions.
      if (driver === "pg") await tx.execute(sql`SELECT pg_advisory_xact_lock(${0x6f736865})`);
      await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS cloud_error_event (
        event_id text PRIMARY KEY,
        occurred_at timestamptz NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        event jsonb NOT NULL
      )
    `);
      await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS cloud_error_event_received_idx ON cloud_error_event (received_at)
    `);
      await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS cloud_error_event_request_idx
        ON cloud_error_event ((event #>> '{context,requestId}'))
    `);
      await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS cloud_error_event_org_idx
        ON cloud_error_event ((event #>> '{context,organizationId}'), received_at DESC)
    `);
    },
    "startup",
  );

  let nextPruneAt = 0;
  return async (events, signal) => {
    if (!events.length || signal.aborted) return;
    const rows = events.map(
      (event) =>
        sql`(${event.eventId}, ${event.timestamp}::timestamptz, ${eventJson(event)}::jsonb)`,
    );
    const prunedUntil = await boundedTransaction(db, async (tx) => {
      // Acquiring a busy pool connection may outlast the reporter's deadline.
      // Never write an abandoned batch when that connection eventually arrives.
      signal.throwIfAborted();
      await tx.execute(sql`
        INSERT INTO cloud_error_event (event_id, occurred_at, event)
        VALUES ${sql.join(rows, sql`, `)}
        ON CONFLICT (event_id) DO NOTHING
      `);
      let prunedUntil = nextPruneAt;
      if (Date.now() >= nextPruneAt) {
        const deleted = await tx.execute(sql`
          DELETE FROM cloud_error_event WHERE event_id IN (
            SELECT event_id FROM cloud_error_event
            WHERE received_at < now() - make_interval(days => ${RETENTION_DAYS})
            ORDER BY received_at LIMIT ${PRUNE_BATCH}
          ) RETURNING event_id
        `);
        prunedUntil = deleted.rows.length < PRUNE_BATCH ? Date.now() + PRUNE_INTERVAL_MS : 0;
      }
      signal.throwIfAborted();
      return prunedUntil;
    });
    nextPruneAt = prunedUntil;
  };
}

/** Called after DB/config bootstrap and before API routes or workers start. */
export async function installCloudErrorDestination(): Promise<void> {
  const { env } = await import("@repo/platform/engine/config/env");
  errorReporter.setEnabled(env.CLOUD_MODE);
  if (!env.CLOUD_MODE) return;

  const local = writableErrorSink(process.stderr);
  errorReporter.setSink(local);
  try {
    const { db, getDriver } = await import("@repo/db");
    const write = await createCloudErrorSink(db, getDriver());
    errorReporter.setSink(async (events, signal) => {
      await write(events, signal);
      await local(events, signal);
    });
  } catch (error) {
    // diagnostics-ignore: sink setup failure must use the existing local sink,
    // never recursively retry storage or prevent the API from starting.
    diagnostics.warn(
      "api/cloud-error-destination",
      "Cloud error storage unavailable; using local logs.",
      error,
    );
  }
}
