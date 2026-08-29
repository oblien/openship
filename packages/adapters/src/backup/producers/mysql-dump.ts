/**
 * MysqlDumpProducer — app-consistent MySQL/MariaDB backups.
 *
 * produce: `mysqldump --single-transaction --routines --triggers`,
 *          compressed with whichever codec the container actually has
 *          (zstd > gzip > none, probed). Single-transaction = consistent
 *          read across all InnoDB tables without locking. Routines +
 *          triggers = full schema.
 *
 * restore: `<decompressor> | mysql` via pipeIntoCommand, using the codec
 *          the artifact recorded. mysqldump output is SQL, so the plain
 *          mysql client replays it.
 *
 * Detection: image matches ^(mysql|mariadb|percona):.* with
 * MYSQL_ROOT_PASSWORD + (MYSQL_DATABASE OR explicit db) in env.
 */

import { isDbImage, payloadSpec, shellQuote } from "@repo/core";
import { registerProducer } from "../registry";
import {
  codecSuffix,
  detectDumpCodec,
  recordedCodec,
  safeDumpCommand,
  safeRestoreCommand,
} from "../common/dump-pipeline";
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
export function mysqlCredentials(env: Record<string, string>): { user: string; password: string } {
  if (env.MYSQL_ROOT_PASSWORD) {
    return { user: "root", password: env.MYSQL_ROOT_PASSWORD };
  }
  return { user: env.MYSQL_USER ?? "root", password: env.MYSQL_PASSWORD ?? "" };
}

class MysqlDumpProducerImpl implements BackupProducer {
  readonly kind = "mysql_dump" as const;

  detects(service: ServiceHandle): boolean {
    if (!isDbImage(service.image, "mysql_dump")) return false;
    // Credentials were the only gate, so an undeployed MariaDB that merely had
    // MYSQL_ROOT_PASSWORD in its env selected this producer over the volume fallback
    // and the run failed at the exec. mysqldump needs BOTH. See canExecInService.
    if (!canExecInService(service)) return false;
    return !!(service.env.MYSQL_ROOT_PASSWORD ?? service.env.MYSQL_PASSWORD);
  }

  async *produce(
    service: ServiceHandle,
    executor: BackupExecutor,
    _opts: ProducerOpts,
  ): AsyncIterable<Artifact> {
    const { user, password } = mysqlCredentials(service.env);
    // If a specific DB isn't named, dump all-databases.
    const db = service.env.MYSQL_DATABASE ?? "";
    const dbArg = db ? `--databases ${shellQuote(db)}` : "--all-databases";

    // mysqldump emits plain SQL, so unlike pg_dump/mongodump it has no format of
    // its own to compress into — this is the one producer that genuinely needs an
    // external codec, and the one where it matters most (SQL text compresses
    // roughly an order of magnitude, and #633's report is a 110 GB MySQL dump).
    //
    // So the codec is PROBED rather than assumed. `zstd` happens to be present on
    // MariaDB images (its server packages pull it in for mariadb-backup) which is
    // why this worked at all, but it is absent from plenty of others, and a missing
    // compressor used to be invisible: the pipeline reported ITS status, not
    // mysqldump's. safeDumpCommand fixes the status; the probe fixes the assumption.
    const codec = await detectDumpCodec(service, executor);
    const cmd = safeDumpCommand(
      `mysqldump --single-transaction --routines --triggers -u ${shellQuote(user)} ${dbArg}`,
      codec,
      // `export`, not the `VAR=x cmd` prefix: with a pipeline the prefix form sets
      // the variable on mysqldump only, and the safe-pipeline wrapper puts the
      // compressor in the same shell.
      `export MYSQL_PWD=${shellQuote(password)}`,
    );
    const { stdout, awaitExit } = await executor.execStream(service, cmd);

    yield {
      name: `mysql-dump.sql${codecSuffix(codec)}`,
      stream: stdout,
      payloadKind: "mysql_dump",
      metadata: {
        mysqlUser: user,
        mysqlDatabase: db || "(all)",
        compression: codec,
      },
    };

    const exit = await awaitExit;
    if (exit.code !== 0) {
      throw new Error(`mysqldump exited ${exit.code}: ${exit.stderr.slice(0, 500)}`);
    }
  }

  async restore(
    service: ServiceHandle,
    executor: BackupExecutor,
    artifact: ArtifactRef,
    _opts: RestoreOpts,
  ): Promise<void> {
    const { user, password } = mysqlCredentials(service.env);

    // One `sh -c` level, and the decompressor comes from what the capture recorded
    // rather than being hardcoded to zstd — a gzip-compressed dump fed to `zstd -d`
    // restores nothing. `export` so MYSQL_PWD reaches mysql even as the second
    // process in a pipeline; the shorthand `VAR=x cmd1 | cmd2` would only set it on
    // the decompressor.
    const codec = recordedCodec(artifact.metadata.compression);
    const cmd = safeRestoreCommand(
      codec,
      `mysql -u ${shellQuote(user)}`,
      `export MYSQL_PWD=${shellQuote(password)}`,
    );

    const body = await artifact.open();
    const exit = await executor.pipeIntoCommand(service, cmd, body, {
      // Ceiling from the catalog, so the number is not a per-producer literal.
      timeoutMs: payloadSpec("mysql_dump").restoreTimeoutMs,
    });
    if (exit.code !== 0) {
      throw new Error(`mysql restore exited ${exit.code}: ${exit.stderr.slice(0, 500)}`);
    }
  }
}

export const MysqlDumpProducer = new MysqlDumpProducerImpl();
registerProducer(MysqlDumpProducer);
