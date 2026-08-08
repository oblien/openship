/**
 * RedisRdbProducer — Redis backups via BGSAVE + dump.rdb capture.
 *
 * produce: Issue `redis-cli BGSAVE`, wait until LASTSAVE bumps, then
 *          `cat /data/dump.rdb | zstd` as the artifact stream.
 *
 * restore: Stream artifact → write to /data/dump.rdb → start service.
 *          Redis loads dump.rdb on boot when persistence is enabled.
 *          (The restore orchestrator stops + starts the service around
 *          producer.restore, so writing dump.rdb while Redis is down
 *          is safe — it'll be loaded on next start.)
 *
 * Detection: image matches ^redis([:/]|$)
 *
 * Caveat: Redis with persistence disabled (AOF-only or no-persistence)
 * won't have a usable dump.rdb. UI surfaces this in Chunk 4.
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

const REDIS_IMAGE_RE = /^redis([:/]|$)/i;

class RedisRdbProducerImpl implements BackupProducer {
  readonly kind = "redis_rdb" as const;

  detects(service: ServiceHandle): boolean {
    return !!service.image && REDIS_IMAGE_RE.test(service.image);
  }

  async *produce(
    service: ServiceHandle,
    executor: BackupExecutor,
    _opts: ProducerOpts,
  ): AsyncIterable<Artifact> {
    // Force a fresh dump.rdb to disk, then capture it. BGSAVE is
    // async; we wait until LASTSAVE timestamp advances past the value
    // we read before triggering BGSAVE.
    const auth = service.env.REDIS_PASSWORD
      ? `-a '${service.env.REDIS_PASSWORD.replace(/'/g, "'\\''")}'`
      : "";
    const trigger = `
      LAST=$(redis-cli ${auth} LASTSAVE);
      redis-cli ${auth} BGSAVE >/dev/null;
      for i in $(seq 1 60); do
        CUR=$(redis-cli ${auth} LASTSAVE);
        if [ "$CUR" != "$LAST" ]; then break; fi
        sleep 1;
      done;
      cat /data/dump.rdb | zstd -c -3
    `;

    const { stdout, awaitExit } = await executor.execStream(service, [
      "sh",
      "-c",
      trigger,
    ]);

    yield {
      name: "redis-dump.rdb.zst",
      stream: stdout,
      payloadKind: "redis_rdb",
      metadata: {
        rdbPath: "/data/dump.rdb",
        compression: "zstd",
      },
    };

    const exit = await awaitExit;
    if (exit.code !== 0) {
      throw new Error(`redis BGSAVE/capture exited ${exit.code}: ${exit.stderr.slice(0, 500)}`);
    }
  }

  async restore(
    service: ServiceHandle,
    executor: BackupExecutor,
    artifact: ArtifactRef,
    _opts: RestoreOpts,
  ): Promise<void> {
    // pipe artifact bytes into `zstd -d > /data/dump.rdb`. The
    // restore orchestrator has already stopped the service, so
    // writing to /data is safe.
    const cmd = [
      "sh",
      "-c",
      "zstd -d > /data/dump.rdb && chmod 644 /data/dump.rdb",
    ];
    const body = await artifact.open();
    const exit = await executor.pipeIntoCommand(service, cmd, body, {
      timeoutMs: 30 * 60 * 1000,
    });
    if (exit.code !== 0) {
      throw new Error(`redis restore exited ${exit.code}: ${exit.stderr.slice(0, 500)}`);
    }
  }
}

export const RedisRdbProducer = new RedisRdbProducerImpl();
registerProducer(RedisRdbProducer);
