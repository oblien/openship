/**
 * PathArchiveProducer — back up FOLDERS the operator names, not just the mounts
 * Docker happens to report.
 *
 * ## What was missing
 *
 * Every other producer starts from something the platform discovered: `listSources()`
 * enumerates the container's volumes and bind mounts, and the DB producers key off the
 * image. That covers the data a service declares — and misses everything an operator
 * knows about that the container does not declare:
 *
 *   - a subdirectory of a large volume, when the rest of it is a cache nobody wants in
 *     a nightly artifact;
 *   - a config tree that lives in the image layer because it was written after the
 *     container started (`/etc/nginx/conf.d`, an app's generated `.env`);
 *   - a host directory on a `bare` service, where there are no mounts to enumerate at
 *     all.
 *
 * Before this, the only way to express any of those was `custom_command` with a
 * hand-written `tar` on both sides — which means the operator also hand-writes the
 * exit-status handling, the codec probe, and the restore inverse, and gets an artifact
 * that is permanently unrestorable if they got the inverse wrong. That is the shape of
 * a policy that reports green for a year.
 *
 * ## What this does instead
 *
 * `tar -c -C <path> .` out, `tar -x -C <path>` back, through the SAME shared shell
 * layer every other producer uses: `safeDumpCommand` / `safeRestoreCommand`, so a
 * failing `tar` cannot hide behind the compressor's exit status, and `detectDumpCodec`,
 * so the compressor is probed in the container rather than assumed present.
 *
 * One artifact per path, so a policy naming three folders produces three restorable
 * units rather than one all-or-nothing archive.
 *
 * ## Two deliberate refusals
 *
 * A MISSING path fails the capture. `tar` would also fail, but with its own wording;
 * the prelude names the path and the service instead, because "no such file" from
 * inside a container the operator never sees is not a diagnosis.
 *
 * An EMPTY path fails the capture too, and that is the less obvious call. A legitimately
 * empty directory in a multi-path policy will fail the whole run until the operator
 * removes it from the list — noisy. The alternative is worse and this module's own
 * history says so: a volume mounted one level off its intended target, a service that
 * writes its data somewhere else entirely, an app whose data directory moved between
 * versions — all of them produce an existing, empty directory and a valid ~130-byte tar
 * that lists as a restore point forever. #611 is the same shape, and the rule the
 * volume producer settled on is the rule here: "nothing to back up" is not a successful
 * backup, it means we could not find the data, and the operator has to hear that.
 *
 * ## Consistency
 *
 * Crash-consistent, always, and the artifact says so. `quiesce` is not offered: it
 * works by PAUSING the container, and a paused container cannot run the `tar` this
 * producer execs inside it — asking for it would deadlock rather than degrade. A path
 * that needs a point-in-time copy needs a volume snapshot or a logical dump, and the
 * recorded `consistency: "crash"` is what tells an operator that.
 *
 * ## Live container
 *
 * Both directions exec inside the service, so the docker executor needs a running
 * container (the catalog records this as `restoreNeedsLiveContainer`, and the restore
 * orchestrator refuses early rather than failing mid-apply). The volume producer is the
 * one that works with the container gone, because it mounts into a helper. That
 * asymmetry is real and worth stating: a path under a named volume can be backed up
 * either way, and the volume route survives the service being destroyed.
 *
 * Detection: never auto-matches. Nothing about an image says "back up /var/www", and a
 * guess would either miss the data or archive an operating system.
 */

import type { Readable } from "node:stream";
import {
  normalizeBackupPath,
  payloadSpec,
  shellQuote,
  validateBackupPath,
  validateClearPath,
} from "@repo/core";
import { registerProducer } from "../registry";
import {
  codecSuffix,
  detectDumpCodec,
  recordedCodec,
  safeDumpCommand,
  safeRestoreCommand,
  type DumpCodec,
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

/**
 * Refuse a missing or empty directory, in the container, before `tar` runs.
 *
 * Runs as a `safeDumpCommand` prelude, whose stdout is redirected to stderr — so
 * nothing here can contaminate the artifact even if a check starts printing.
 *
 * The emptiness test is `find … -mindepth 1 … -print -quit`: it stops at the first
 * entry instead of walking the tree, so it costs nothing on a directory with a million
 * files, and it counts dotfiles, which `ls` would not.
 */
function guardSourcePath(path: string, serviceName: string): string {
  const q = shellQuote(path);
  return [
    `if [ ! -d ${q} ]; then`,
    `  echo "openship: ${path} does not exist inside service ${serviceName} (or is not a directory), ` +
      `so there is nothing to archive. Check the path, or point the policy at a volume instead." >&2`,
    `  exit 66`,
    `fi`,
    `if [ -z "$(find ${q} -mindepth 1 -print -quit 2>/dev/null)" ]; then`,
    `  echo "openship: ${path} exists inside service ${serviceName} but is empty. Refusing to record ` +
      `an empty archive as a backup — a directory that should hold data and does not usually means ` +
      `the data lives somewhere else (a volume mounted one level off, or an app that moved its data ` +
      `directory). Fix the path, or remove it from the policy if it is expected to be empty." >&2`,
    `  exit 67`,
    `fi`,
  ].join("\n");
}

/**
 * Prove the decompressor exists, create the target if needed, and only THEN clear it.
 *
 * The ordering is the whole point, and it is not theoretical: the volume executor
 * carries the same guard because without it a missing `zstd` produced `find -delete`
 * followed by `tar -x` reading EOF and exiting 0 — the target emptied, nothing
 * extracted, and a green restore. `safeRestoreCommand` now surfaces the decompressor's
 * status, but that happens AFTER a prelude has already run, so the prelude has to prove
 * the tool itself before it destroys anything.
 *
 * `mkdir -p` rather than a refusal: restoring a folder into a service that does not yet
 * have it is the ordinary case for a rebuilt container, and it is the one thing that
 * makes a path artifact useful after the service was recreated from its image.
 */
function guardRestorePath(path: string, codec: DumpCodec, clear: boolean): string {
  const q = shellQuote(path);
  const tool = codec === "zstd" ? "zstd" : codec === "gzip" ? "gzip" : null;
  const lines: string[] = [];
  if (tool && clear) {
    lines.push(
      `command -v ${tool} >/dev/null 2>&1 || { echo "openship: ${tool} is not available inside ` +
        `this service, so the archive cannot be decompressed. Refusing to clear ${path}: nothing ` +
        `was written and your data is untouched." >&2; exit 90; }`,
    );
  }
  lines.push(`mkdir -p ${q} || exit 91`);
  if (clear) {
    // Confined to one directory's immediate children, by construction: `-mindepth 1
    // -maxdepth 1` under a path that `validateClearPath` already required to be at
    // least two segments deep and outside every system root. `|| true` on the delete
    // alone — a file the container cannot remove must not abort the restore, and tar
    // will overwrite it anyway.
    lines.push(`find ${q} -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true`);
  }
  return lines.join("\n");
}

/** Filename-safe rendering of a path: `/var/www/html` → `var_www_html`. */
function pathSlug(path: string): string {
  return (
    path
      .replace(/^\/+/, "")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 80) || "root"
  );
}

class PathArchiveProducerImpl implements BackupProducer {
  readonly kind = "path" as const;

  // No detects() — explicit selection only. See the module doc.

  async *produce(
    service: ServiceHandle,
    executor: BackupExecutor,
    opts: ProducerOpts,
  ): AsyncIterable<Artifact> {
    const requested = opts.paths ?? [];
    if (requested.length === 0) {
      throw new Error(
        `Nothing to back up for service "${service.name}": this policy archives files and ` +
          `folders but names none. Set \`payloadConfig.paths\` to one or more absolute paths ` +
          `inside the service.`,
      );
    }

    // Re-validated here, not only at save time. A policy row can predate the
    // validation, be written by a migration, or arrive from an import — and every one
    // of these strings is interpolated into a shell command.
    const paths: string[] = [];
    for (const entry of requested) {
      const problem = validateBackupPath(entry);
      if (problem) throw new Error(problem);
      const normalized = normalizeBackupPath(entry);
      if (!paths.includes(normalized)) paths.push(normalized);
    }

    /**
     * An explicit choice WINS; otherwise probe.
     *
     * Probing is the right default here and not for volumes: a volume archive runs in
     * a helper image this module controls and can `apk add` into, while a path archive
     * runs in the operator's own container, whose contents we do not get to choose.
     *
     * But `compression` is one of this kind's declared config keys, so ignoring it
     * would have made the control in the dialog decorative — and an operator picking
     * `gzip` on an image that happens to have zstd would silently have got zstd.
     * Probed once for the whole run either way: the codec is a property of the
     * container, and every path lives in the same one.
     *
     * An explicit codec the container lacks fails the capture loudly (the compressor's
     * status is surfaced by `safeDumpCommand`), which is the right outcome — silently
     * downgrading would write artifacts whose compression nobody chose.
     */
    const codec: DumpCodec = opts.compression ?? (await detectDumpCodec(service, executor));

    for (const path of paths) {
      const { stdout, awaitExit } = await executor.execStream(
        service,
        safeDumpCommand(
          // `-C <dir> .` rather than `tar -c <dir>`: the archive holds the directory's
          // CONTENTS at relative paths, so it can be extracted into a different
          // location — which is what makes an artifact captured from /data/app
          // restorable after the app moved to /srv/app.
          `tar -c -C ${shellQuote(path)} ${
            (opts.exclude ?? []).map((p) => `--exclude=${shellQuote(p)}`).join(" ")
          } .`.replace(/\s+/g, " "),
          codec,
          guardSourcePath(path, service.name),
        ),
      );

      yield {
        name: `path-${pathSlug(path)}.tar${codecSuffix(codec)}`,
        stream: stdout as unknown as Readable,
        payloadKind: "path",
        metadata: {
          // The restore target. Recorded per-artifact rather than read back off the
          // policy, because a policy is editable and soft-deletable: an artifact has to
          // carry everything needed to put it back, or it stops being a restore point
          // the moment somebody edits the schedule.
          path,
          compression: codec,
          // See the module doc: always crash-consistent, and the artifact says so
          // rather than leaving an operator to assume otherwise.
          consistency: "crash",
        },
      };

      const exit = await awaitExit;
      if (exit.code !== 0) {
        throw new Error(
          `Archiving ${path} from service "${service.name}" failed (exit ${exit.code}): ` +
            `${exit.stderr.slice(0, 500)}`,
        );
      }
    }
  }

  async restore(
    service: ServiceHandle,
    executor: BackupExecutor,
    artifact: ArtifactRef,
    opts: RestoreOpts,
  ): Promise<void> {
    const recorded = artifact.metadata.path;
    if (typeof recorded !== "string" || recorded.trim() === "") {
      throw new Error(
        `Artifact ${artifact.key} cannot restore: metadata.path missing. This artifact may ` +
          `have been produced by a different producer.`,
      );
    }
    const path = normalizeBackupPath(recorded);
    // The recorded path is about to be interpolated into a shell command, so it is
    // validated on the way IN as well as on the way out — artifact metadata is stored
    // data, and stored data is not a trust boundary.
    const problem = validateBackupPath(path);
    if (problem) throw new Error(`Artifact ${artifact.key} records an unusable path. ${problem}`);

    const codec = recordedCodec(artifact.metadata.compression);

    // Clearing is opt-in and separately guarded. `clearTarget` defaults TRUE for a
    // volume restore, because a volume is a single-purpose store and a merge leaves
    // files the artifact never had. A path is not that: it can be a directory the
    // service also uses for other things, so the default here is to extract OVER what
    // is there and let the operator ask for a replace.
    const wantsClear = opts.clearTarget === true;
    if (wantsClear) {
      const unsafe = validateClearPath(path);
      if (unsafe) throw new Error(unsafe);
    }

    const body = await artifact.open();
    const exit = await executor.pipeIntoCommand(
      service,
      safeRestoreCommand(
        codec,
        `tar -x -C ${shellQuote(path)}`,
        guardRestorePath(path, codec, wantsClear),
      ),
      body,
      { timeoutMs: payloadSpec("path").restoreTimeoutMs },
    );
    if (exit.code !== 0) {
      throw new Error(
        `Restoring ${path} into service "${service.name}" failed (exit ${exit.code}): ` +
          `${exit.stderr.slice(0, 500)}`,
      );
    }
  }
}

export const PathArchiveProducer = new PathArchiveProducerImpl();
registerProducer(PathArchiveProducer);
