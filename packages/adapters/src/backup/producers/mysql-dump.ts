/**
 * MysqlDumpProducer — app-consistent MySQL/MariaDB backups.
 *
 * produce: `mysqldump --single-transaction --routines --triggers | zstd`
 *          Single-transaction = consistent read across all InnoDB
 *          tables without locking. Routines + triggers = full schema.
 *
 * restore: `zstd -d | mysql` via pipeIntoCommand. mysqldump output is
 *          SQL, so plain mysql client replays it.
 *
 * Detection: image matches ^(mysql|mariadb|percona):.* with
 * MYSQL_ROOT_PASSWORD + (MYSQL_DATABASE OR explicit db) in env.
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

const MYSQL_IMAGE_RE = /^(mysql|mariadb|percona\/percona-server):/i;

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function mysqlCredentials(env: Record<string, string>): { user: string; password: string } {
  if (env.MYSQL_ROOT_PASSWORD) {
    return { user: "root", password: env.MYSQL_ROOT_PASSWORD };
  }
  return { user: env.MYSQL_USER ?? "root", password: env.MYSQL_PASSWORD ?? "" };
}

class MysqlDumpProducerImpl implements BackupProducer {
  readonly kind = "mysql_dump" as const;

  detects(service: ServiceHandle): boolean {
    if (!service.image || !MYSQL_IMAGE_RE.test(service.image)) return false;
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
    const dbArg = db ? `--databases ${shellEscape(db)}` : "--all-databases";

    const cmd = [
      "sh",
      "-c",
      `MYSQL_PWD=${shellEscape(password)} mysqldump --single-transaction --routines --triggers -u ${shellEscape(user)} ${dbArg} | zstd -c -3`,
    ];
    const { stdout, awaitExit } = await executor.execStream(service, cmd);

    yield {
      name: "mysql-dump.sql.zst",
      stream: stdout,
      payloadKind: "mysql_dump",
      metadata: {
        mysqlUser: user,
        mysqlDatabase: db || "(all)",
        compression: "zstd",
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

    // Collapsed to a SINGLE `sh -c` level. `export` so MYSQL_PWD
    // reaches mysql (the second process in the pipeline) — the
    // shorthand `VAR=x cmd1 | cmd2` would only export to zstd.
    const cmd = [
      "sh",
      "-c",
      `export MYSQL_PWD=${shellEscape(password)}; zstd -d | mysql -u ${shellEscape(user)}`,
    ];

    const body = await artifact.open();
    const exit = await executor.pipeIntoCommand(service, cmd, body, {
      timeoutMs: 60 * 60 * 1000,
    });
    if (exit.code !== 0) {
      throw new Error(`mysql restore exited ${exit.code}: ${exit.stderr.slice(0, 500)}`);
    }
  }
}

export const MysqlDumpProducer = new MysqlDumpProducerImpl();
registerProducer(MysqlDumpProducer);
