/**
 * Direct server-to-server migration transfer — the SOURCE box talks straight to
 * the TARGET box (single hop over their own link), instead of relaying every
 * byte through the API host. `rsync` moves volume/bind data (delta + resume +
 * `--info=progress2`); `docker save | ssh <peer> docker load` moves the image.
 *
 * The two servers don't trust each other yet, so we bootstrap an EPHEMERAL,
 * per-run SSH trust: `ssh-keygen` on the initiator (the private key is born on
 * that box and never touches the API host or the logs), the public half is
 * appended to the peer's authorized_keys under a run-tagged marker, and the
 * peer's host key is pinned via `ssh-keyscan`. Everything is torn down in the
 * caller's `finally` — a leaked authorized_keys line is lingering access.
 *
 * Reachability is the real variable (server↔server port 22 may be firewalled
 * even when the API host reaches both), so `establishDirectLink` TRIES BOTH
 * DIRECTIONS — push (source→target), then pull (target→source) for asymmetric
 * firewalls — and returns null only when neither connects. The caller then
 * fails loudly (no silent relay) unless the operator explicitly picked the
 * relay override.
 *
 * All commands run on the initiator via the CommandExecutor interface
 * (`exec`/`streamExec`), so the initiator may be a remote SSH box OR the local
 * API-host server (server-host mode) — no `rawExec`, works for both.
 *
 * Security: every interpolated value is shell-escaped (`sq`); the private key is
 * generated on the box (never written from the API host, never echoed); the
 * peer host key is pinned (StrictHostKeyChecking=yes + a scanned known_hosts).
 */

import type { CommandExecutor, LogEntry } from "@repo/adapters";

/** POSIX single-quote escape — matches adapters' `sq` (duplicated across the
 *  codebase; trivial, kept local to avoid a cross-package export). */
export function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** SSH endpoint of a server (from its DB row). */
export interface ServerConn {
  host: string;
  port: number;
  user: string;
}

export interface DirectProgress {
  (bytesMoved: number, total?: number): void;
}

/** A live source→target link once trust is bootstrapped and reachability
 *  proven. `initiator` is the box running the commands (whichever direction
 *  connected); `sshCommand` is the peer-directed `ssh …` prefix (no host). */
export interface DirectLink {
  direction: "push" | "pull";
  /** Stream the image source→target (docker save <id> | ssh peer docker load),
   *  then re-apply the tag on the target (save-by-id loads untagged). */
  transferImage(image: { id: string; tag: string }, onProgress?: DirectProgress): Promise<void>;
  /** rsync a volume's data source→target. Creates the target volume, resolves
   *  both mountpoints, then moves bytes. `dstName` (clone) lands the source
   *  volume's data in a DIFFERENTLY-named target volume; defaults to `volumeName`. */
  transferVolume(volumeName: string, onProgress?: DirectProgress, dstName?: string): Promise<void>;
  /** rsync a bind-mount host path source→target (same absolute path). */
  transferBind(hostPath: string, onProgress?: DirectProgress): Promise<void>;
  /** rsync an arbitrary source path → a (possibly different) destination path. */
  transferPath(sourcePath: string, destPath: string, onProgress?: DirectProgress): Promise<void>;
  /** Remove the ephemeral trust on both sides. Idempotent; never throws. */
  cleanup(): Promise<void>;
}

interface LinkContext {
  sourceExec: CommandExecutor;
  targetExec: CommandExecutor;
  sourceConn: ServerConn;
  targetConn: ServerConn;
  runId: string;
  /** rsync `-z` on the wire (opt-in — helps WAN, wasteful on a fast LAN). */
  compress?: boolean;
  log: (message: string) => void;
}

const PROBE_TIMEOUT_MS = 15_000;
const KEYSCAN_TIMEOUT_MS = 12_000;

/** `command -v` presence check over any executor (no SSH-only `hasRemoteCommand`
 *  dep, so a local initiator works too). */
async function hasCommand(exec: CommandExecutor, cmd: string): Promise<boolean> {
  const out = await exec
    .exec(`command -v ${sq(cmd)} >/dev/null 2>&1 && echo ok || true`, { timeout: 8000 })
    .catch(() => "");
  return out.trim() === "ok";
}

/** Marker written as the key's `-C` comment — unique per run, so removal targets
 *  exactly our authorized_keys line and nothing else. */
function trustMarker(runId: string, tag: string): string {
  return `openship-migration-${runId}-${tag}`;
}

/**
 * Bootstrap one-directional trust: keygen on `initiatorExec`, install the pubkey
 * on `peerExec`'s authorized_keys, pin the peer's host key. Returns the
 * peer-directed `ssh …` command prefix (options only, no host) plus a cleanup.
 * On any failure the partial state is cleaned before rethrowing.
 */
async function bootstrapTrust(
  initiatorExec: CommandExecutor,
  peerExec: CommandExecutor,
  peerConn: ServerConn,
  runId: string,
  tag: string,
  log: (m: string) => void,
): Promise<{ sshCommand: string; cleanup: () => Promise<void> }> {
  const marker = trustMarker(runId, tag);
  const tmp = `/tmp/${marker}`;
  const keyFile = `${tmp}/id`;
  const knownHosts = `${tmp}/known_hosts`;

  const cleanupInitiator = async () => {
    await initiatorExec.exec(`rm -rf ${sq(tmp)}`).catch(() => {});
  };
  const cleanupPeer = async () => {
    // Strip our marker line from the peer's authorized_keys (rewrite in place).
    const ak = "$HOME/.ssh/authorized_keys";
    await peerExec
      .exec(
        `if [ -f ${ak} ]; then grep -v ${sq(marker)} ${ak} > ${ak}.openship.tmp 2>/dev/null || true; ` +
          `mv ${ak}.openship.tmp ${ak} 2>/dev/null || true; fi`,
      )
      .catch(() => {});
  };
  const cleanup = async () => {
    await cleanupInitiator();
    await cleanupPeer();
  };

  try {
    // 1. Keygen on the initiator — private key born here, never leaves.
    await initiatorExec.exec(
      `mkdir -p ${sq(tmp)} && chmod 700 ${sq(tmp)} && ` +
        `ssh-keygen -t ed25519 -N '' -f ${sq(keyFile)} -C ${sq(marker)} >/dev/null`,
    );
    const pubKey = (await initiatorExec.exec(`cat ${sq(`${keyFile}.pub`)}`)).trim();
    if (!pubKey.includes("ssh-ed25519")) {
      throw new Error("ephemeral key generation produced no public key");
    }

    // 2. Install the pubkey on the peer's authorized_keys (600, dir 700).
    await peerExec.exec(
      `mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" && ` +
        `printf '%s\\n' ${sq(pubKey)} >> "$HOME/.ssh/authorized_keys" && ` +
        `chmod 600 "$HOME/.ssh/authorized_keys"`,
    );

    // 3. Pin the peer's host key (scan from the initiator → known_hosts).
    const scan = await initiatorExec.exec(
      `ssh-keyscan -T 8 -p ${peerConn.port} ${sq(peerConn.host)} 2>/dev/null > ${sq(knownHosts)}; ` +
        `wc -c < ${sq(knownHosts)}`,
      { timeout: KEYSCAN_TIMEOUT_MS },
    );
    if (Number(scan.trim()) <= 0) {
      throw new Error(`could not scan host key of ${peerConn.host}:${peerConn.port}`);
    }

    // Bare (unquoted) paths on purpose: this string is used BOTH inside a shell
    // (sshTo) AND as rsync's `-e` value, which tokenize quoting differently.
    // The temp dir is fully controlled (/tmp/openship-migration-<hex>-<tag>) —
    // no spaces or shell-specials — so bare is safe and unambiguous for both.
    const sshCommand =
      `ssh -i ${keyFile} -o IdentitiesOnly=yes -o BatchMode=yes ` +
      `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts} ` +
      // Keepalive: a silently-stalled link is torn down after ~60s → the rsync
      // exits non-zero and runRsync's retry resumes, instead of hanging forever.
      `-o ServerAliveInterval=15 -o ServerAliveCountMax=4 ` +
      `-o ConnectTimeout=10 -p ${peerConn.port}`;

    log(`trust bootstrapped (${tag})`);
    return { sshCommand, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** `<sshCommand> user@host <remote>` — the peer-directed invocation. */
function sshTo(sshCommand: string, peer: ServerConn, remote: string): string {
  return `${sshCommand} ${sq(`${peer.user}@${peer.host}`)} ${remote}`;
}

/** Probe that the initiator can actually reach the peer AND the peer has the
 *  tools we need (rsync + docker). This is the real server↔server reachability
 *  check — the API host's own probe can't see it. */
async function probeDirectLink(
  initiatorExec: CommandExecutor,
  sshCommand: string,
  peer: ServerConn,
): Promise<boolean> {
  const out = await initiatorExec
    .exec(
      sshTo(
        sshCommand,
        peer,
        `'command -v rsync >/dev/null && command -v docker >/dev/null && echo OPENSHIP_LINK_OK'`,
      ),
      { timeout: PROBE_TIMEOUT_MS },
    )
    .catch(() => "");
  return out.includes("OPENSHIP_LINK_OK");
}

/** Resolve a named volume's on-host mountpoint (handles a custom data-root). */
async function volumeMountpoint(exec: CommandExecutor, name: string): Promise<string> {
  const out = await exec.exec(
    `docker volume inspect ${sq(name)} --format '{{.Mountpoint}}'`,
  );
  const mp = out.trim();
  if (!mp) throw new Error(`could not resolve mountpoint for volume ${name}`);
  return mp;
}

/** Existence + type of a path on `exec`'s host, in one probe. A bind source can
 *  be a FILE (a config file) as easily as a directory — the transfer must know
 *  which, because a directory-slash on a file makes rsync `change_dir` into it
 *  ("Not a directory", exit 23). */
export async function statPath(
  exec: CommandExecutor,
  path: string,
): Promise<"dir" | "file" | "missing"> {
  const out = (
    await exec
      .exec(`[ -d ${sq(path)} ] && echo dir || { [ -e ${sq(path)} ] && echo file || echo missing; }`)
      .catch(() => "missing")
  ).trim();
  return out === "dir" ? "dir" : out === "file" ? "file" : "missing";
}

/** Thrown when a bind/custom source path doesn't exist on the source. The
 *  orchestrator turns this into a resolvable `pendingItem` (→ `partial`) instead
 *  of aborting + rolling back the whole migration. */
export class PathMissingError extends Error {
  constructor(public readonly path: string) {
    super(`source path not found: ${path}`);
    this.name = "PathMissingError";
  }
}

/** Parse an `rsync --info=progress2` line → cumulative bytes transferred, or
 *  null for a non-progress line. Format: "  1,234,567  12%  1.23MB/s  0:00:05". */
export function parseRsyncProgress(line: string): number | null {
  const m = line.match(/^\s*([\d,]+)\s+\d+%/);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Build the rsync command for one path move (direction decides which end
 *  carries the `user@host:` prefix). Always moves source→target. Exported for
 *  unit tests (pure). */
export function rsyncCommand(
  sshCommand: string,
  peer: ServerConn,
  localPath: string,
  peerPath: string,
  pushToPeer: boolean,
  compress: boolean,
  /** true = directory (trailing slash → sync CONTENTS); false = a single file. */
  dir = true,
): string {
  // --partial + --partial-dir keep a dropped transfer's bytes so a re-invoke
  // RESUMES instead of restarting (see runRsync's retry loop). --timeout aborts
  // a stalled link so the retry can kick in.
  const flags = `-a --partial --partial-dir=.openship-partial --info=progress2 --timeout=60${compress ? " -z" : ""}`;
  const dash_e = `-e ${sq(sshCommand)}`;
  const slash = dir ? "/" : "";
  const local = `${sq(localPath)}${slash}`;
  const remote = `${sq(`${peer.user}@${peer.host}:${peerPath}`)}${slash}`;
  // rsync source-spec then dest-spec.
  return pushToPeer
    ? `rsync ${flags} ${dash_e} ${local} ${remote}`
    : `rsync ${flags} ${dash_e} ${remote} ${local}`;
}

/** Parent directory of an absolute path (for `mkdir -p` before an rsync). */
function parentDir(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

const RSYNC_MAX_ATTEMPTS = 5;

/**
 * Run an rsync move on the initiator, streaming progress out via onProgress.
 * Resilient to a dropped/stalled connection: on a non-zero exit it re-invokes
 * the SAME command up to RSYNC_MAX_ATTEMPTS times — rsync resumes from the
 * `--partial`/`--partial-dir` bytes rather than restarting. A permission error
 * is NOT retryable (retrying is futile), so it bails immediately. Exported for
 * unit tests.
 */
export async function runRsync(
  initiatorExec: CommandExecutor,
  command: string,
  onProgress?: DirectProgress,
  log?: (m: string) => void,
): Promise<void> {
  let lastTail = "";
  for (let attempt = 1; attempt <= RSYNC_MAX_ATTEMPTS; attempt++) {
    const { code, output } = await initiatorExec.streamExec(command, (entry: LogEntry) => {
      if (!onProgress) return;
      const bytes = parseRsyncProgress(entry.message);
      if (bytes != null) onProgress(bytes);
    });
    if (code === 0) return;

    lastTail = output.split("\n").filter(Boolean).slice(-4).join(" ");
    // Permission problems never recover on retry — fail loud and fast.
    if (/permission denied|Operation not permitted/i.test(lastTail)) {
      throw new Error(
        `rsync failed (exit ${code}) — the SSH user cannot read/write the Docker volume path. ` +
          `Use a root (or docker-group) SSH user on both servers. ${lastTail}`,
      );
    }
    if (attempt < RSYNC_MAX_ATTEMPTS) {
      log?.(`rsync exit ${code} (attempt ${attempt}/${RSYNC_MAX_ATTEMPTS}) — resuming`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(
    `rsync failed after ${RSYNC_MAX_ATTEMPTS} attempts: ${lastTail || "no output"}`,
  );
}

/**
 * Try to establish a working direct link source→target. Bootstraps push trust
 * and probes; on failure tears it down and tries the pull mirror. Returns null
 * when neither direction connects (caller fails loudly). The returned link owns
 * the trust cleanup.
 */
export async function establishDirectLink(ctx: LinkContext): Promise<DirectLink | null> {
  const { sourceExec, targetExec, sourceConn, targetConn, runId, log } = ctx;
  const compress = ctx.compress ?? false;

  const makeLink = (
    direction: "push" | "pull",
    sshCommand: string,
    trustCleanup: () => Promise<void>,
  ): DirectLink => {
    const initiatorExec = direction === "push" ? sourceExec : targetExec;
    const peerConn = direction === "push" ? targetConn : sourceConn;
    // push: data flows initiator(source)→peer(target). pull: peer(source)→initiator(target).
    const pushToPeer = direction === "push";

    return {
      direction,
      async transferImage(image, onProgress) {
        // Save BY ID (reliable even if the tag drifted); re-tag on the target
        // after load (a save-by-id load is untagged, but the deploy adopts the
        // tag as its imageRef).
        // push: save on source (initiator) → load on target (peer over ssh).
        // pull: save on source (peer over ssh) → load on target (initiator).
        const save = `docker save ${sq(image.id)}`;
        const load = `docker load`;
        const command = pushToPeer
          ? `${save} | ${sshTo(sshCommand, peerConn, sq(load))}`
          : `${sshTo(sshCommand, peerConn, sq(save))} | ${load}`;
        // Coarse size hint for the bar (docker save has no native progress).
        // The image always lives on the source; inspect by id (always resolves).
        const sizeOut = await sourceExec
          .exec(`docker image inspect ${sq(image.id)} --format '{{.Size}}' 2>/dev/null || echo 0`)
          .catch(() => "0");
        const total = Number(sizeOut.trim()) || undefined;
        log(`image ${image.tag}: streaming ${direction}${total ? ` (~${Math.round(total / 1048576)} MB)` : ""}`);
        onProgress?.(0, total);
        const { code, output } = await initiatorExec.streamExec(command, () => {});
        if (code !== 0) {
          const tail = output.split("\n").filter(Boolean).slice(-4).join(" ");
          throw new Error(`image transfer failed (exit ${code}): ${tail || "no output"}`);
        }
        // Re-apply the tag on the TARGET. `docker save <id>` is untagged and the
        // load restores it under the CONFIG image id (≠ the source `image.id`,
        // which is often a RepoDigest) — so tagging by `image.id` fails with
        // "No such image". Instead retag from what `docker load` actually reported
        // ("Loaded image( ID)?: <ref>"), which comes back over the pipe. Only skip
        // when the load already restored the exact target tag.
        const loaded = output.match(/Loaded image(?: ID)?:\s*(\S+)/i)?.[1]?.trim();
        const from = loaded && loaded !== image.tag ? loaded : loaded ? null : image.id;
        if (from) {
          const tagCmd = `docker tag ${sq(from)} ${sq(image.tag)}`;
          const retag = await (pushToPeer
            ? initiatorExec.exec(sshTo(sshCommand, peerConn, sq(`${tagCmd} 2>&1`)))
            : targetExec.exec(`${tagCmd} 2>&1`)
          ).catch((e) => (e instanceof Error ? e.message : String(e)));
          if (retag && /error|no such/i.test(retag)) {
            // An untagged image = the target can't resolve it = the deploy would
            // fall back to a registry pull. Surface loudly, don't swallow.
            throw new Error(`image ${image.tag}: retag failed — ${retag.trim()}`);
          }
          log(`image ${image.tag}: tagged on target (from ${from})`);
        }
        if (total) onProgress?.(total, total);
      },
      async transferVolume(volumeName, onProgress, dstName) {
        // Ensure the (possibly differently-named, for clone) volume exists on the
        // TARGET, resolve both mountpoints.
        const targetExecLocal = targetExec;
        const sourceExecLocal = sourceExec;
        const targetName = dstName ?? volumeName;
        await targetExecLocal.exec(`docker volume create ${sq(targetName)} >/dev/null`);
        const [srcMount, dstMount] = await Promise.all([
          volumeMountpoint(sourceExecLocal, volumeName),
          volumeMountpoint(targetExecLocal, targetName),
        ]);
        // On the initiator, "local" is the initiator's side of the move.
        const localPath = direction === "push" ? srcMount : dstMount;
        const peerPath = direction === "push" ? dstMount : srcMount;
        log(`volume ${volumeName}${dstName ? ` → ${dstName}` : ""}: rsync ${direction}${compress ? " (z)" : ""}`);
        await runRsync(
          initiatorExec,
          rsyncCommand(sshCommand, peerConn, localPath, peerPath, pushToPeer, compress),
          onProgress,
          log,
        );
      },
      async transferBind(hostPath, onProgress) {
        // Same absolute path on both ends. Detect file vs dir on the SOURCE and
        // rsync accordingly; a missing source becomes a pending item upstream.
        const kind = await statPath(sourceExec, hostPath);
        if (kind === "missing") throw new PathMissingError(hostPath);
        const isDir = kind === "dir";
        // Dir → the path itself; file → its parent (the file lands inside it).
        await runOnTarget(`mkdir -p ${sq(isDir ? hostPath : parentDir(hostPath))}`).catch(() => {});
        log(`bind ${hostPath}: rsync ${direction}${compress ? " (z)" : ""} (${isDir ? "dir" : "file"})`);
        await runRsync(
          initiatorExec,
          rsyncCommand(sshCommand, peerConn, hostPath, hostPath, pushToPeer, compress, isDir),
          onProgress,
          log,
        );
      },
      async transferPath(sourcePath, destPath, onProgress) {
        // sourceExec is always the SOURCE server; detect file vs dir there.
        const kind = await statPath(sourceExec, sourcePath);
        if (kind === "missing") throw new PathMissingError(sourcePath);
        const isDir = kind === "dir";
        await runOnTarget(`mkdir -p ${sq(isDir ? destPath : parentDir(destPath))}`).catch(() => {});
        // On the initiator, "local" is the initiator's side; source→dest always.
        const localPath = pushToPeer ? sourcePath : destPath;
        const peerPath = pushToPeer ? destPath : sourcePath;
        log(`path ${sourcePath} → ${destPath}: rsync ${direction}${compress ? " (z)" : ""} (${isDir ? "dir" : "file"})`);
        await runRsync(
          initiatorExec,
          rsyncCommand(sshCommand, peerConn, localPath, peerPath, pushToPeer, compress, isDir),
          onProgress,
          log,
        );
      },
      cleanup: trustCleanup,
    };

    /** Run a command on the TARGET box (peer for push, initiator for pull). */
    function runOnTarget(cmd: string): Promise<string> {
      return pushToPeer
        ? initiatorExec.exec(sshTo(sshCommand, peerConn, sq(cmd)))
        : targetExec.exec(cmd);
    }
  };

  // ── Try push: source is the initiator, reaches the target ──
  try {
    const push = await bootstrapTrust(sourceExec, targetExec, targetConn, runId, "push", log);
    if (await probeDirectLink(sourceExec, push.sshCommand, targetConn)) {
      return makeLink("push", push.sshCommand, push.cleanup);
    }
    log("push link unreachable — trying pull");
    await push.cleanup();
  } catch (err) {
    log(`push setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Try pull: target is the initiator, reaches the source ──
  try {
    const pull = await bootstrapTrust(targetExec, sourceExec, sourceConn, runId, "pull", log);
    if (await probeDirectLink(targetExec, pull.sshCommand, sourceConn)) {
      return makeLink("pull", pull.sshCommand, pull.cleanup);
    }
    log("pull link unreachable");
    await pull.cleanup();
  } catch (err) {
    log(`pull setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}
