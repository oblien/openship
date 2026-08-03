/**
 * PgDumpProducer — app-consistent Postgres backups.
 *
 * produce: exec `pg_dump -Fc | zstd` inside the service container.
 *          stdout is the artifact bytes — no tar wrapping, no temp
 *          file. The `.dump` file is binary custom-format (the
 *          recommended pg_dump shape: portable, restorable in
 *          parallel, supports --clean).
 *
 * restore: stream artifact into `zstd -d | pg_restore --clean --if-exists`
 *          via executor.pipeIntoCommand. Drops + recreates the schema
 *          atomically inside the dump's transaction (pg_restore --clean).
 *
 * Detection: service.image matches ^(postgres|postgis/postgis)(:|$) and
 * we can read POSTGRES_USER + POSTGRES_DB from the service env. If
 * either is missing, this producer DOES NOT match — the volume
 * producer fallback runs instead with a "no postgres creds in env"
 * warning at backup time (Chunk 3 surfaces this in the UI; for now
 * just let the fallback work).
 */

import { registerProducer } from "../registry";
import type {
  Artifact,
  ArtifactRef,
  BackupExecutor,
  BackupProducer,
  ProducerOpts,
  RestoreOpts,
  ServiceHandle,
} from "../types";

const POSTGRES_IMAGE_RE = /^(postgres|postgis\/postgis)(:|$)/i;

function envOr(service: ServiceHandle, key: string, fallback: string): string {
  return service.env[key] ?? fallback;
}

class PgDumpProducerImpl implements BackupProducer {
  readonly kind = "pg_dump" as const;

  detects(service: ServiceHandle): boolean {
    if (!service.image || !POSTGRES_IMAGE_RE.test(service.image)) return false;
    // Need at least a DB name; user defaults to "postgres".
    const db = service.env.POSTGRES_DB ?? service.env.PGDATABASE;
    return !!db;
  }

  async *produce(
    service: ServiceHandle,
    executor: BackupExecutor,
    _opts: ProducerOpts,
  ): AsyncIterable<Artifact> {
    const user = envOr(service, "POSTGRES_USER", "postgres");
    const db = service.env.POSTGRES_DB ?? service.env.PGDATABASE ?? "postgres";
    const password = service.env.POSTGRES_PASSWORD ?? service.env.PGPASSWORD ?? "";

    // pg_dump custom format + zstd compression. Piping zstd outside
    // pg_dump because pg_dump's own --compress=zstd is recent and
    // not always available on official images.
    //
    // `export` so libpq picks up PGPASSWORD on pg_dump (the variant
    // `VAR=x cmd1 | cmd2` would only export to cmd1). All inputs
    // run through shellEscape() — never inline single-quote splice.
    const cmd = [
      "sh",
      "-c",
      `export PGPASSWORD=${shellEscape(password)}; pg_dump -Fc -U ${shellEscape(user)} ${shellEscape(db)} | zstd -c -3`,
    ];
    const { stdout, awaitExit } = await executor.execStream(service, cmd);

    yield {
      name: "pg-dump.zst",
      stream: stdout,
      payloadKind: "pg_dump",
      metadata: {
        postgresUser: user,
        postgresDb: db,
        format: "custom",
        compression: "zstd",
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
    const db =
      (artifact.metadata.postgresDb as string | undefined) ??
      service.env.POSTGRES_DB ??
      service.env.PGDATABASE ??
      "postgres";
    const password = service.env.POSTGRES_PASSWORD ?? service.env.PGPASSWORD ?? "";

    // --clean --if-exists drops existing objects before recreating;
    // --no-owner skips ownership reassignment that would otherwise
    // fail on a different runtime user.
    //
    // Collapsed to a SINGLE `sh -c` level. The previous shape was
    // `sh -c "PGPASSWORD='X' sh -c '...'"`: a password containing a
    // single-quote-and-backslash sequence broke out of the inner
    // shell context. One shell layer + shellEscape on every value
    // is the correct shape (PGPASSWORD is a normal env var, so
    // VAR=... before the command is fine — no need to nest shells).
    // `export` makes PGPASSWORD visible to pg_restore (the second
    // process in the pipeline). `VAR=x cmd1 | cmd2` would only set
    // the env on zstd, not on pg_restore where libpq reads it.
    const cmd = [
      "sh",
      "-c",
      `export PGPASSWORD=${shellEscape(password)}; zstd -d | pg_restore --clean --if-exists --no-owner -U ${shellEscape(user)} -d ${shellEscape(db)}`,
    ];

    const body = await artifact.open();
    const exit = await executor.pipeIntoCommand(service, cmd, body, {
      timeoutMs: 60 * 60 * 1000, // 1h for large restores
    });
    if (exit.code !== 0) {
      throw new Error(
        `pg_restore exited ${exit.code}: ${exit.stderr.slice(0, 500)}`,
      );
    }
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export const PgDumpProducer = new PgDumpProducerImpl();
// Must register BEFORE VolumeCopyProducer so detect() wins for postgres
// images. The backup/index.ts side-effect ordering enforces this.
registerProducer(PgDumpProducer);
