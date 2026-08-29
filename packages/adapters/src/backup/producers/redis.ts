/**
 * RedisRdbProducer — Redis backups via BGSAVE + dump.rdb capture.
 *
 * produce: Issue `redis-cli BGSAVE`, wait until LASTSAVE bumps, then
 *          `cat /data/dump.rdb` (compressed with whatever codec the
 *          container has, probed) as the artifact stream.
 *
 * restore: refuse if AOF is on → disable save points → stream artifact into
 *          /data/dump.rdb, all against the RUNNING container. Redis reads that
 *          file only at STARTUP, so the orchestrator BOUNCES the service
 *          afterwards (`NEEDS_BOUNCE_AFTER_WRITE`) and that bounce is what
 *          applies the restore.
 *
 *          The header used to claim the orchestrator "stops + starts the service
 *          around producer.restore". It does not, and had not for some time:
 *          `redis_rdb` is in `NEEDS_LIVE_CONTAINER` (the write needs a live
 *          container), which means `stoppedByUs` is false and no restart site
 *          fires. So the file was written under a running Redis that never read
 *          it — a restore reported as succeeded with the dataset untouched, and
 *          the next ordinary restart snapshotted over the artifact.
 *
 * Detection: image matches ^redis:.* AND there is a container we can exec in.
 *
 * Caveat: Redis with persistence disabled won't have a usable dump.rdb to
 * capture. AOF-only is refused at RESTORE time rather than silently no-oping, and a
 * save the capture cannot PROVE happened is refused at capture time — see produce for
 * why an unverified BGSAVE is worse than a failed one.
 */

import type { Readable } from "node:stream";
import { isDbImage, payloadSpec, shellQuote, withTimeout } from "@repo/core";
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
  ExecExitInfo,
  ProducerOpts,
  RestoreOpts,
  ServiceHandle,
} from "../types";
import { canExecInService } from "../common/exec-target";

/**
 * Read a short probe's stdout to a string.
 *
 * It DRAINS the stream rather than just awaiting the exit, because `awaitExit` can
 * settle before the first `data` event ever fires — which made the first version of
 * the AOF check read an empty string and wave every AOF-enabled Redis through, i.e.
 * exactly the silent no-op it was added to prevent.
 *
 * Bounded three ways: 4 KiB of output kept, and a wall clock, and an unknown answer
 * is returned as empty so the caller PROCEEDS. A probe that cannot answer must not
 * block a restore — if the container is that unresponsive the restore fails on its
 * own, with a better error than this one could give.
 */
async function probeOutput(res: {
  stdout: Readable;
  awaitExit: Promise<ExecExitInfo>;
}): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const drained = new Promise<void>((resolve) => {
    res.stdout.on("data", (c: Buffer) => {
      if (size < 4096) {
        chunks.push(Buffer.from(c));
        size += c.byteLength;
      }
    });
    res.stdout.once("end", () => resolve());
    res.stdout.once("error", () => resolve());
    res.stdout.once("close", () => resolve());
  });
  await withTimeout(drained, PROBE_TIMEOUT_MS, "redis config probe timed out").catch(
    () => undefined,
  );
  await res.awaitExit.catch(() => undefined);
  return Buffer.concat(chunks).toString("utf8");
}

const PROBE_TIMEOUT_MS = 30_000;

/**
 * How long to wait for BGSAVE to land before failing the capture.
 *
 * Deliberately under the executors' 10-minute idle watchdog: the wait prints nothing,
 * so a window longer than that watchdog would be killed as a wedged exec — a worse
 * error than the one this raises, describing the wrong problem.
 */
const BGSAVE_WAIT_SECONDS = 300;

class RedisRdbProducerImpl implements BackupProducer {
  readonly kind = "redis_rdb" as const;

  detects(service: ServiceHandle): boolean {
    if (!isDbImage(service.image, "redis_rdb")) return false;
    // `redis-cli BGSAVE` runs inside the container. Image alone used to be the whole
    // test, so an undeployed or stopped redis selected this producer over the volume
    // fallback and the run failed at the exec. See canExecInService.
    return canExecInService(service);
  }

  async *produce(
    service: ServiceHandle,
    executor: BackupExecutor,
    _opts: ProducerOpts,
  ): AsyncIterable<Artifact> {
    // Force a fresh dump.rdb to disk, then capture it. BGSAVE is async; we wait until
    // the LASTSAVE timestamp advances past the value read before triggering it.
    //
    // Every step of that is now CHECKED, because the version that was not is the one
    // failure neither the zero-byte guard nor the integrity hash can catch: it produced
    // a valid, restorable, STALE artifact. The old loop `break`ed out after 60 tries
    // either way and captured /data/dump.rdb regardless, so three different situations
    // all archived whatever an earlier save had left on disk and reported a green
    // backup —
    //
    //   - a dataset that needs longer than the wait to fork-and-write;
    //   - a wrong `redis-cli` password, which makes BOTH LASTSAVE calls fail
    //     identically, so the timestamp "never changes" for the whole wait;
    //   - a BGSAVE that Redis started and could not finish (no space in the
    //     container being the usual one), which never advances LASTSAVE at all.
    //
    // Each now exits non-zero with its own reason. The numeric `case` is what separates
    // the auth failure from a slow save: an error reply captured through `2>&1` is not a
    // timestamp, and testing the TEXT rather than `redis-cli`'s exit status keeps this
    // independent of which Redis version decides an error reply deserves exit 1.
    const cli = this.cli(service);
    // Under the executor's 10-minute idle watchdog on purpose: nothing prints while we
    // wait, so a longer wait would be killed as a wedged exec instead of reported as a
    // slow save.
    const waitSeconds = BGSAVE_WAIT_SECONDS;
    // The BGSAVE + wait runs as the PRELUDE, so it is not part of the pipeline whose
    // status gets masked, and `cat` is the only thing on the producing side. `zstd`
    // is not in a stock redis image, which is why this is probed rather than assumed
    // — an RDB is already LZF-compressed internally, so `none` costs little.
    const codec = await detectDumpCodec(service, executor);
    const prelude = [
      // One reader for both LASTSAVE calls, because reading it correctly is not a
      // one-liner: `redis-cli -a` has printed an auth warning on EVERY invocation since
      // 4.0, so the capture is two lines and folding it into the timestamp with a bare
      // `2>&1` would make every password-protected Redis look unreachable. Take the last
      // all-digits LINE as the reply, and keep the rest as the diagnostic.
      `lastsave() {`,
      `  RAW=$(${cli} LASTSAVE 2>&1 | tr -d '\\r')`,
      `  TS=$(printf '%s\\n' "$RAW" | grep -E '^[0-9]+$' | tail -n 1)`,
      `}`,
      `lastsave`,
      `[ -n "$TS" ] || {`,
      `  echo "openship: could not read Redis LASTSAVE, so a captured dump.rdb could not be` +
        ` proven fresh — refusing to archive a possibly stale one. redis-cli said: $RAW" >&2`,
      `  exit 91`,
      `}`,
      `LAST=$TS`,
      // Both halves of "did BGSAVE start", because which one answers depends on the
      // version: Redis 6+ exits non-zero on an error reply, older builds exit 0 and only
      // print it. An already-RUNNING save is not a failure — it will advance LASTSAVE, so
      // the wait below covers it — and its reply contains ERR, which is why that arm comes
      // first.
      //
      // `already in progress` and not `in progress`: Redis has a SECOND error with that
      // phrase — "Can't BGSAVE while AOF log rewriting is in progress" — and it means the
      // opposite, that no save was started at all. Matching the loose phrase waved it
      // through and left the wait polling for a timestamp nothing was going to move.
      `BG=$(${cli} BGSAVE 2>&1 | tr -d '\\r') || BGFAIL=1`,
      `case "$BG" in`,
      `  *"already in progress"*) ;;`,
      `  *ERR*) BGFAIL=1 ;;`,
      `esac`,
      `[ -z "$BGFAIL" ] || {`,
      `  echo "openship: Redis would not start a background save, so /data/dump.rdb is` +
        ` whatever an earlier save left there — refusing to archive it as this backup.` +
        ` redis-cli said: $BG" >&2`,
      `  exit 92`,
      `}`,
      `i=0; SAVED=0`,
      `while [ "$i" -lt ${waitSeconds} ]; do`,
      `  lastsave`,
      `  [ -n "$TS" ] || {`,
      `    echo "openship: lost contact with Redis while waiting for BGSAVE to finish.` +
        ` redis-cli said: $RAW" >&2`,
      `    exit 91`,
      `  }`,
      `  if [ "$TS" != "$LAST" ]; then SAVED=1; break; fi`,
      // Fail on a save Redis has already given up on rather than waiting out the whole
      // window for a timestamp that is never going to move. Gated on
      // `rdb_bgsave_in_progress:0` because the status field still reports the PREVIOUS
      // save's result while a new one runs. A missing `tr`/`grep`/`INFO` leaves this
      // empty, which matches nothing and falls through to the timeout below — the checks
      // here only ever ADD a reason to fail, never a reason to pass.
      `  INFO=$(${cli} INFO persistence 2>/dev/null | tr -d '\\r')`,
      `  case "$INFO" in *rdb_bgsave_in_progress:0*)`,
      `    case "$INFO" in *rdb_last_bgsave_status:err*)`,
      `      echo "openship: Redis reported its background save FAILED` +
        ` (rdb_last_bgsave_status:err) — usually no free space where /data lives. Nothing` +
        ` fresh was written, so refusing to archive the previous save." >&2`,
      `      exit 93 ;;`,
      `    esac ;;`,
      `  esac`,
      `  i=$((i+1)); sleep 1`,
      `done`,
      `[ "$SAVED" = 1 ] || {`,
      `  echo "openship: Redis BGSAVE did not finish within ${waitSeconds}s — LASTSAVE never` +
        ` advanced, so /data/dump.rdb is still the PREVIOUS save. Refusing to archive it as` +
        ` this backup; use a volume payload for a dataset this large, or retry." >&2`,
      `  exit 94`,
      `}`,
    ].join("\n");
    // `cat` fails loudly on a redis with persistence disabled (no /data/dump.rdb),
    // which is the documented caveat below — and used to be swallowed, because the
    // pipeline reported the compressor's status instead of cat's.
    const cmd = safeDumpCommand("cat /data/dump.rdb", codec, prelude);

    const { stdout, awaitExit } = await executor.execStream(service, cmd);

    yield {
      name: `redis-dump.rdb${codecSuffix(codec)}`,
      stream: stdout,
      payloadKind: "redis_rdb",
      metadata: {
        rdbPath: "/data/dump.rdb",
        compression: codec,
      },
    };

    const exit = await awaitExit;
    if (exit.code !== 0) {
      throw new Error(`redis BGSAVE/capture exited ${exit.code}: ${exit.stderr.slice(0, 500)}`);
    }
  }

  /** `redis-cli` with auth, when a password is discoverable. */
  private cli(service: ServiceHandle): string {
    const pass = service.env.REDIS_PASSWORD;
    return pass ? `redis-cli -a ${shellQuote(pass)}` : "redis-cli";
  }

  async restore(
    service: ServiceHandle,
    executor: BackupExecutor,
    artifact: ArtifactRef,
    _opts: RestoreOpts,
  ): Promise<void> {
    // Two things have to be true for these bytes to become the live dataset, and
    // neither was checked. Redis reads dump.rdb only at STARTUP, so the write alone
    // changes nothing — the orchestrator bounces the service afterwards
    // (NEEDS_BOUNCE_AFTER_WRITE). And that bounce is only safe if Redis will not
    // write over the file on its way down, or ignore it on the way up:
    //
    //   - a configured save point makes SIGTERM snapshot the CURRENT dataset over
    //     the file we just restored, so the restore undoes itself;
    //   - AOF, if enabled, is what Redis loads at startup INSTEAD of the RDB, so the
    //     restore is a silent no-op no matter how the bounce goes.
    //
    // The AOF case cannot be worked around from here (the container's own config
    // decides it at startup, and `CONFIG SET appendonly no` does not survive the
    // restart), so it REFUSES rather than reporting a success that applied nothing.
    const aofValue = await probeOutput(
      await executor.execStream(service, [
        "sh",
        "-c",
        `${this.cli(service)} CONFIG GET appendonly 2>/dev/null | tail -n 1`,
      ]),
    );
    if (aofValue.trim().toLowerCase() === "yes") {
      throw new Error(
        `This Redis has AOF persistence enabled (appendonly yes), so at startup it loads ` +
          `its append-only file INSTEAD of dump.rdb — restoring this RDB artifact would ` +
          `change nothing. Disable appendonly on the service and redeploy before restoring ` +
          `an RDB, or restore from a volume backup, which replaces /data wholesale.`,
      );
    }

    // Best-effort: stop Redis snapshotting over the file we are about to write. A
    // failure here is not fatal — a Redis with no save points configured (the common
    // container default) has nothing to disable, and `CONFIG SET` is unavailable on
    // some managed builds.
    await executor
      .execStream(service, ["sh", "-c", `${this.cli(service)} CONFIG SET save '' >/dev/null 2>&1`])
      .then((r) => r.awaitExit)
      .catch(() => undefined);

    // Pipe artifact bytes into /data/dump.rdb, decompressing only if the capture
    // recorded a codec. Redis is RUNNING for this write (the file is not read again
    // until startup), which is why redis_rdb is in NEEDS_LIVE_CONTAINER.
    const codec = recordedCodec(artifact.metadata.compression);
    const cmd = safeRestoreCommand(codec, "cat > /data/dump.rdb && chmod 644 /data/dump.rdb");
    const body = await artifact.open();
    const exit = await executor.pipeIntoCommand(service, cmd, body, {
      // Ceiling from the catalog, so the number is not a per-producer literal.
      timeoutMs: payloadSpec("redis_rdb").restoreTimeoutMs,
    });
    if (exit.code !== 0) {
      throw new Error(`redis restore exited ${exit.code}: ${exit.stderr.slice(0, 500)}`);
    }
  }
}

export const RedisRdbProducer = new RedisRdbProducerImpl();
registerProducer(RedisRdbProducer);
