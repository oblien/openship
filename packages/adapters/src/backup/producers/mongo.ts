/**
 * MongoDumpProducer — MongoDB backups via mongodump --archive.
 *
 * produce: `mongodump --archive --gzip` streams BSON archive to stdout.
 *          --archive merges every collection into one stream — clean
 *          single artifact, no per-collection files.
 *
 * restore: `mongorestore --archive --gzip --drop` via pipeIntoCommand.
 *          --drop wipes existing collections before importing.
 *
 * Detection: image matches ^(mongo|percona/percona-server-mongodb):.*
 */

import { isDbImage, payloadSpec, shellQuote } from "@repo/core";
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
import { canExecInService } from "../common/exec-target";
class MongoDumpProducerImpl implements BackupProducer {
  readonly kind = "mongo_dump" as const;

  detects(service: ServiceHandle): boolean {
    if (!isDbImage(service.image, "mongo_dump")) return false;
    // mongodump runs inside the container. Image alone used to be the whole test,
    // so a mongo service that had never deployed selected this producer over the
    // volume fallback and the run failed at the exec. See canExecInService.
    return canExecInService(service);
  }

  private authArgs(service: ServiceHandle): string {
    const user =
      service.env.MONGO_INITDB_ROOT_USERNAME ?? service.env.MONGODB_ROOT_USERNAME ?? "";
    const pass =
      service.env.MONGO_INITDB_ROOT_PASSWORD ?? service.env.MONGODB_ROOT_PASSWORD ?? "";
    if (!user || !pass) return "";
    return `-u ${shellQuote(user)} -p ${shellQuote(pass)} --authenticationDatabase admin`;
  }

  async *produce(
    service: ServiceHandle,
    executor: BackupExecutor,
    _opts: ProducerOpts,
  ): AsyncIterable<Artifact> {
    const auth = this.authArgs(service);
    const cmd = ["sh", "-c", `mongodump ${auth} --archive --gzip`];
    const { stdout, awaitExit } = await executor.execStream(service, cmd);

    yield {
      name: "mongo-dump.archive.gz",
      stream: stdout,
      payloadKind: "mongo_dump",
      metadata: { format: "archive", compression: "gzip" },
    };

    const exit = await awaitExit;
    if (exit.code !== 0) {
      throw new Error(`mongodump exited ${exit.code}: ${exit.stderr.slice(0, 500)}`);
    }
  }

  async restore(
    service: ServiceHandle,
    executor: BackupExecutor,
    artifact: ArtifactRef,
    _opts: RestoreOpts,
  ): Promise<void> {
    const auth = this.authArgs(service);
    const cmd = [
      "sh",
      "-c",
      `mongorestore ${auth} --archive --gzip --drop`,
    ];

    const body = await artifact.open();
    const exit = await executor.pipeIntoCommand(service, cmd, body, {
      // Ceiling from the catalog, so the number is not a per-producer literal.
      timeoutMs: payloadSpec("mongo_dump").restoreTimeoutMs,
    });
    if (exit.code !== 0) {
      throw new Error(`mongorestore exited ${exit.code}: ${exit.stderr.slice(0, 500)}`);
    }
  }
}

export const MongoDumpProducer = new MongoDumpProducerImpl();
registerProducer(MongoDumpProducer);
