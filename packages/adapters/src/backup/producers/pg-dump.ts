/**
 * PgDumpProducer — app-consistent Postgres backups.
 *
 * produce: exec `pg_dump -Fc <db>` inside the service container. stdout is
 *          the artifact bytes — no tar wrapping, no temp file, and no
 *          external compressor (the custom format is zlib-compressed
 *          already). The database name follows the postgres image's own
 *          rule: POSTGRES_DB, else POSTGRES_USER, else `postgres`.
 *
 * restore: stream the artifact into `pg_restore --clean --if-exists` via
 *          executor.pipeIntoCommand, decompressing only if the artifact
 *          recorded an external codec.
 *
 * BOUNDARY: one database per artifact — a cluster hosting several gets its
 * primary one, same as before this producer existed. `pg_dumpall` would cover
 * them all but cannot be restored honestly (see produce).
 *
 * Detection: service.image matches ^(postgres|postgis/postgis):.* and the
 * service has a live container.
 *
 * It deliberately does NOT require POSTGRES_DB in the env any more. That
 * requirement is what made the control plane's own postgres — whose service
 * rows are built from running containers and carry no env — read as "not a
 * database", so the volume fallback ran, found no recorded volumes, and
 * reported a green backup of nothing (#611). Two things were wrong with it:
 *
 *   - It is not needed. The postgres image documents that POSTGRES_DB defaults
 *     to POSTGRES_USER, which defaults to `postgres`, so the database name is
 *     derivable without the env var being set at all.
 *   - It made the dashboard's "Detected PostgreSQL — backs it up with pg_dump"
 *     hint a lie, because that hint tests the image alone. Detection is now the
 *     same shape as the hint, so the two cannot disagree about what will run.
 *
 * A crash-consistent tar of a live Postgres data directory was never the better
 * fallback for a RUNNING postgres, so preferring the logical dump is the right
 * default even where both are possible.
 */

import { isDbImage, payloadSpec, shellQuote } from "@repo/core";
import { registerProducer } from "../registry";
import { recordedCodec, safeDumpCommand, safeRestoreCommand } from "../common/dump-pipeline";
import type {
  Artifact,
  ArtifactRef,
  BackupExecutor,
  BackupProducer,
  ProducerOpts,
  RestoreOpts,
  ServiceHandle,
} from "../types";
import { canExecInService } from "../common/exec-target";

function envOr(service: ServiceHandle, key: string, fallback: string): string {
  return service.env[key] ?? fallback;
}

class PgDumpProducerImpl implements BackupProducer {
  readonly kind = "pg_dump" as const;

  detects(service: ServiceHandle): boolean {
    if (!isDbImage(service.image, "pg_dump")) return false;
    // A logical dump has to run INSIDE the database, so no USABLE container means
    // this producer cannot work at all and the volume fallback is the honest answer
    // (it can still tar a stopped service's recorded volumes — and a stopped
    // database's volume is the cold, consistent copy). See canExecInService: a
    // container id alone is not the test, because a stopped container has one.
    return canExecInService(service);
  }

  async *produce(
    service: ServiceHandle,
    executor: BackupExecutor,
    _opts: ProducerOpts,
  ): AsyncIterable<Artifact> {
    const user = envOr(service, "POSTGRES_USER", "postgres");
    // The official postgres image's OWN defaulting rule: POSTGRES_DB defaults to the
    // value of POSTGRES_USER, and POSTGRES_USER defaults to `postgres`. Applying it
    // here is what lets detection stop requiring POSTGRES_DB in the env — the gap that
    // made the control plane's own postgres read as "not a database" (#611) — without
    // inventing a second artifact format.
    //
    // An earlier draft used `pg_dumpall` when no database was named. It is the better
    // artifact on paper (every database plus roles and grants) and it is what an
    // operator runs by hand, but its RESTORE could not be made honest: pg_dumpall emits
    // plain SQL full of CREATE ROLE / CREATE DATABASE, so `psql` either aborts on the
    // first object that already exists (with ON_ERROR_STOP=1) or reports success having
    // applied almost nothing (without it). "Reports success having applied almost
    // nothing" is the exact failure this whole pass exists to remove, so shipping a
    // payload we cannot restore would have replaced one lie with another.
    const db =
      service.env.POSTGRES_DB ??
      service.env.PGDATABASE ??
      service.env.POSTGRES_USER ??
      "postgres";
    const password = service.env.POSTGRES_PASSWORD ?? service.env.PGPASSWORD ?? "";

    // NO external compressor: `-Fc` is the custom format, which pg_dump already
    // compresses (zlib level 6 unless --compress=0), so the old `| zstd -c -3`
    // re-compressed compressed bytes and charged two real prices for it:
    //
    //   1. It required `zstd` INSIDE the user's postgres container. It is not there on
    //      a stock `postgres:*-alpine` — the executor's own volume helper has to
    //      `apk add --no-cache zstd` into alpine for exactly this reason — so pg_dump
    //      was writing into a pipe with no reader.
    //   2. A pipeline exits with its LAST command's status, so `sh` reported zstd's
    //      result and pg_dump's own failure (a wrong password, a pg_hba refusal, a
    //      missing binary) was invisible. See common/dump-pipeline.ts for how that
    //      turned a failed dump into a "successful" backup of a valid-looking file.
    //
    // Dropping the pipe removes both: no codec dependency, and `sh -c` reports
    // pg_dump's own exit status directly.
    //
    // `export` so libpq picks up PGPASSWORD. Every value goes through shellQuote() —
    // never inline single-quote splice.
    const cmd = safeDumpCommand(
      `pg_dump -Fc -U ${shellQuote(user)} ${shellQuote(db)}`,
      "none",
      `export PGPASSWORD=${shellQuote(password)}`,
    );
    const { stdout, awaitExit } = await executor.execStream(service, cmd);

    yield {
      // These bytes are pg_dump's own container format, which pg_restore reads
      // directly. `.dump` is what the Postgres docs call it.
      name: "pg-dump.dump",
      stream: stdout,
      payloadKind: "pg_dump",
      metadata: {
        postgresUser: user,
        postgresDb: db,
        format: "custom",
        // The EXTERNAL codec only. The custom format's internal zlib is pg_restore's
        // own business, so a `-Fc` artifact records "none".
        compression: "none",
      },
    };

    const exit = await awaitExit;
    if (exit.code !== 0) {
      throw new Error(
        `pg_dump exited ${exit.code}: ${exit.stderr.slice(0, 500)}`,
      );
    }
  }

  async restore(
    service: ServiceHandle,
    executor: BackupExecutor,
    artifact: ArtifactRef,
    _opts: RestoreOpts,
  ): Promise<void> {
    const user = envOr(service, "POSTGRES_USER", "postgres");
    const password = service.env.POSTGRES_PASSWORD ?? service.env.PGPASSWORD ?? "";
    const codec = recordedCodec(artifact.metadata.compression);

    // ONE loader. An earlier draft dispatched on a recorded `format` — `pg_restore` for
    // the custom format, `psql` for a pg_dumpall plain-SQL artifact — and that second
    // branch was removed along with the pg_dumpall capture it existed for (see produce),
    // so there is nothing left to choose between.
    //
    // The DECOMPRESSOR is still read from the record rather than hardcoded: artifacts
    // written before this pass are custom-format AND recorded `compression: "zstd"`,
    // which is why recordedCodec() defaults to zstd rather than none for an unknown
    // value — guessing `none` there would feed a compressed file straight into
    // pg_restore.
    //
    // One `sh -c` level. The previous shape was `sh -c "PGPASSWORD='X' sh -c '...'"`: a
    // password containing a single-quote-and-backslash sequence broke out of the inner
    // shell context. One shell layer + shellEscape on every value is the correct shape.
    // `export` is what makes PGPASSWORD visible to the loader when it is the second
    // process in a pipeline.
    const db =
      (artifact.metadata.postgresDb as string | undefined) ??
      service.env.POSTGRES_DB ??
      service.env.PGDATABASE ??
      service.env.POSTGRES_USER ??
      "postgres";
    // `--single-transaction` is the atomicity guarantee, and it is the reason a failed
    // pg restore is now a NON-EVENT rather than a half-restored database.
    //
    // Measured, not assumed. With the flags this line used to carry
    // (`--clean --if-exists --no-owner`), a restore whose `DROP TABLE` was blocked by a
    // dependent view carried on regardless: the tables it COULD drop were replaced, the
    // one it could not kept its live rows AND received the archive's rows on top, and
    // pg_restore finished with `warning: errors ignored on restore: 3`. The database was
    // left holding a merge of two points in time that matches neither.
    //
    // It did NOT report success — pg_restore exits 1 when it ignores errors, so the
    // `exit.code !== 0` check below already failed the run. That is precisely why this
    // flag costs nothing: every restore it can newly abort was ALREADY being reported as
    // failed; the only change is that it now fails before touching the data instead of
    // after. Same experiment with `--single-transaction`: exit 1, the failing statement
    // named in stderr, and both tables still holding exactly their pre-restore rows.
    //
    // `--single-transaction` implies `--exit-on-error`, so passing both is redundant.
    //
    // `--no-acl` is the necessary companion, not an unrelated tidy-up. A single-database
    // `-Fc` archive carries its GRANTs but NOT the roles they name — `CREATE ROLE` is
    // cluster-global, `pg_dumpall --globals-only` territory, and nothing here captures
    // it. So restoring into a FRESH container (the disaster-recovery case, the one that
    // matters most) hits a grant to a role that does not exist yet, and under one
    // transaction that single ignorable error would abort the whole restore and land
    // nothing at all. Skipping privileges is the same decision `--no-owner` already
    // made, and it is made at RESTORE time so the archive itself stays complete for an
    // operator who wants to apply them by hand.
    const cmd = safeRestoreCommand(
      codec,
      `pg_restore --clean --if-exists --no-owner --no-acl --single-transaction ` +
        `-U ${shellQuote(user)} -d ${shellQuote(db)}`,
      `export PGPASSWORD=${shellQuote(password)}`,
    );

    const body = await artifact.open();
    const exit = await executor.pipeIntoCommand(service, cmd, body, {
      // Ceiling from the catalog, so the number is not a per-producer literal.
      timeoutMs: payloadSpec("pg_dump").restoreTimeoutMs,
    });
    if (exit.code !== 0) {
      throw new Error(
        `pg_restore exited ${exit.code}: ${exit.stderr.slice(0, 500)}`,
      );
    }
  }
}
export const PgDumpProducer = new PgDumpProducerImpl();
// Must register BEFORE VolumeCopyProducer so detect() wins for postgres
// images. The backup/index.ts side-effect ordering enforces this.
registerProducer(PgDumpProducer);
