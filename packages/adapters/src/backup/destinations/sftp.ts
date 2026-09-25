/**
 * SFTP destination — backup storage on any SSH-reachable host.
 *
 * Streaming-native: ssh2's SFTP layer exposes createReadStream /
 * createWriteStream, so the orchestrator pipes artifact bytes
 * directly without buffering on the API host.
 *
 * Atomic uploads: write to `<path>.uploading`, then sftp.rename to
 * `<path>` after the stream closes. POSIX rename is atomic on the
 * same filesystem.
 *
 * Connection lifecycle: one ssh2 Client per put/get/head/delete call.
 * Backup operations are infrequent (one-shot per artifact), so the
 * connection-per-call overhead is amortized into the upload itself.
 * The Chunk 2 retention-prune sweep batches deletes through
 * `deleteMany` so we don't spin up N connections for N deletions.
 *
 * Used by BOTH `sftp` and `openship_server` destination kinds — the
 * apps/api layer translates `openship_server` rows into SFTP rows
 * (hydrating creds from the user's `servers` table) before
 * resolveDestination sees them.
 */

import { Client, type SFTPWrapper } from "ssh2";
import { posix } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { decryptCredential } from "../common/credentials";
import { registerDestination } from "../registry";
import { safeErrorMessage } from "@repo/core";
import type {
  BackupDestination,
  BackupDestinationRow,
  DestinationCapability,
  HeadInfo,
  ListOpts,
  ListPage,
  PutOpts,
  PutResult,
} from "../types";

const CAPS: ReadonlySet<DestinationCapability> = new Set<DestinationCapability>([
  "streamingPut",
  "streamingGet",
]);

/**
 * Idle ceiling for one artifact upload — silence, not wall clock, for the same
 * reason capture and restore bound on idle: an honest multi-hour artifact must
 * not be strangled, and a wedged one must not be forever.
 *
 * Must never be TIGHTER than the producer's own idle allowance (execStream's
 * 10-minute default). `put`'s body is the dump stream itself, so from here a
 * source that has gone quiet — pg_dump waiting on a lock, a cold-cache table
 * scan, a user's custom command — is indistinguishable from a dead destination.
 * A shorter bound here would silently override that budget and fail healthy
 * backups of large databases.
 */
const TRANSFER_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const UPLOAD_STALL_PROBE_MS = 30 * 1000;

/**
 * Write buffer for one artifact upload — and therefore how many SFTP write requests
 * ride the link at once, since ssh2 pipelines everything Node hands it in a single
 * `_writev`. See `put` for why the default 16 KB caps an upload at roughly one
 * packet per round trip.
 *
 * 8 MB against a 32 KB SFTP packet is on the order of 256 requests in flight, which
 * is the same neighbourhood as ssh2's own `fastPut` default (64) with room for the
 * larger chunks a demuxed dump delivers. It is a per-upload memory ceiling, and
 * uploads are one-at-a-time within a run.
 */
const UPLOAD_BUFFER_BYTES = 8 * 1024 * 1024;
const SFTP_CONTROL_TIMEOUT_MS = 10_000;

/** Control requests must also settle when a broken channel drops its callbacks. */
function sftpRequest<T = void>(
  label: string,
  start: (done: (error?: Error | null, value?: T) => void) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const onAbort = () => finish(signal?.reason ?? new Error("SFTP connection closed"));
    const timer = setTimeout(
      () => finish(new Error(`SFTP ${label} timed out`)),
      SFTP_CONTROL_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    try {
      start(finish);
    } catch (error) {
      finish(error as Error);
    }
  });
}

interface ConnectionConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

class SftpDestinationImpl implements BackupDestination {
  readonly kind: "sftp" | "openship_server";
  readonly capabilities = CAPS;

  private readonly conn: ConnectionConfig;
  private readonly rootPath: string;

  constructor(row: BackupDestinationRow) {
    this.kind = row.kind === "openship_server" ? "openship_server" : "sftp";

    if (!row.sshHost) {
      throw new Error(`SFTP destination "${row.name}" missing sshHost`);
    }
    if (!row.sshUser) {
      throw new Error(`SFTP destination "${row.name}" missing sshUser`);
    }

    const password = decryptCredential(row.sftpPasswordEnc);
    const privateKey = decryptCredential(row.sftpPrivateKeyEnc);
    const passphrase = decryptCredential(row.sftpKeyPassphraseEnc);

    if (!password && !privateKey) {
      throw new Error(
        `SFTP destination "${row.name}" requires a password or private key`,
      );
    }

    this.conn = {
      host: row.sshHost,
      port: row.sshPort ?? 22,
      username: row.sshUser,
      ...(password ? { password } : {}),
      ...(privateKey ? { privateKey, ...(passphrase ? { passphrase } : {}) } : {}),
    };
    this.rootPath = (row.pathPrefix ?? "/").replace(/\/+$/, "") || "/";
  }

  private fullPath(key: string): string {
    if (key.includes("\0")) {
      throw new Error("Key contains a null byte");
    }
    const cleaned = key.replace(/^\/+/, "");

    // posix.join collapses '.' but NOT '..' that walks above the root —
    // normalize first, then assert the normalized result still sits
    // under rootPath. An attacker-controlled segment like `../../etc`
    // would otherwise let an SFTP destination write outside its
    // configured pathPrefix.
    const root = posix.resolve("/", this.rootPath);
    const candidate = posix.resolve(root, cleaned);
    if (root !== "/" && candidate !== root && !candidate.startsWith(root + "/")) {
      throw new Error(
        `SFTP key escapes destination root (${this.rootPath}): ${key}`,
      );
    }
    return candidate;
  }

  // ── Connection helper ────────────────────────────────────────────────

  private async withSftp<T>(
    fn: (sftp: SFTPWrapper, signal: AbortSignal) => Promise<T>,
    timeoutMs?: number,
    cancelSignal?: AbortSignal,
  ): Promise<T> {
    const client = new Client();
    const abort = new AbortController();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        cancelSignal?.removeEventListener("abort", onCancel);
        try {
          client.end();
        } catch {
          // already ended
        }
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        abort.abort(error);
        cleanup();
        reject(error);
      };
      const onCancel = () => fail(cancelSignal?.reason ?? new Error("SFTP operation cancelled"));
      cancelSignal?.addEventListener("abort", onCancel, { once: true });
      if (cancelSignal?.aborted) return onCancel();
      if (timeoutMs) {
        timer = setTimeout(() => fail(new Error("SFTP cleanup timed out")), timeoutMs);
      }
      client
        .on("ready", () => {
          if (settled) return;
          sftpRequest<SFTPWrapper>("channel open", (done) => client.sftp(done), abort.signal)
            .then((sftp) => {
              abort.signal.throwIfAborted();
              return fn(sftp, abort.signal);
            })
            .then(
              (val) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(val);
              },
              fail,
            );
        })
        .on("error", fail)
        .on("close", () => fail(new Error("SFTP connection closed before the operation completed")));
      try {
        client.connect(this.conn);
      } catch (error) {
        fail(error);
      }
    });
  }

  // ── Recursive mkdir (SFTP has no mkdir -p) ───────────────────────────

  private async ensureDir(sftp: SFTPWrapper, dir: string, signal: AbortSignal): Promise<void> {
    const parts = dir.split("/").filter(Boolean);
    let current = dir.startsWith("/") ? "" : ".";
    for (const part of parts) {
      current = current === "" ? `/${part}` : posix.join(current, part);
      // eslint-disable-next-line no-await-in-loop
      await sftpRequest("directory creation", (done) => {
        sftp.mkdir(current, (err) => {
          if (signal.aborted) return;
          if (!err) return done();
          // EEXIST / "Failure" / code 4 = already exists. We can't
          // reliably check by code (depends on server), so try stat
          // and treat-as-ok if it's a directory.
          sftp.stat(current, (statErr, stats) => {
            if (statErr) return done(err);
            if (stats.isDirectory()) return done();
            done(new Error(`${current} exists but is not a directory`));
          });
        });
      }, signal);
    }
  }

  /** A missing file is already clean; every deletion uses the same deadline. */
  private async unlinkIfPresent(
    sftp: SFTPWrapper,
    path: string,
    signal: AbortSignal,
    label = "file deletion",
  ): Promise<void> {
    await sftpRequest(label, (done) => {
      sftp.unlink(path, (error) => {
        const missing = (error as { code?: number } | null)?.code === 2;
        done(missing ? null : error);
      });
    }, signal);
  }

  // ── BackupDestination interface ──────────────────────────────────────

  async preflight(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const probeName = `.openship-probe-${randomBytes(6).toString("hex")}`;
      await this.withSftp(async (sftp, signal) => {
        await this.ensureDir(sftp, this.rootPath, signal);
        const probePath = posix.join(this.rootPath, probeName);
        await sftpRequest("write probe", (done) => {
          // ssh2's autoClose destroys in _final, before Node can emit finish.
          // Close explicitly after finish so a complete write and an interrupted
          // write remain distinguishable on both Node and Bun.
          const ws = sftp.createWriteStream(probePath, { autoClose: false });
          let finishedWriting = false;
          ws.on("finish", () => { finishedWriting = true; ws.destroy(); });
          ws.on("error", done);
          ws.on("close", () => done(
            finishedWriting ? undefined : new Error("SFTP write probe closed before all bytes were written"),
          ));
          ws.end("ok");
        }, signal);
        await this.unlinkIfPresent(sftp, probePath, signal);
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: safeErrorMessage(err),
      };
    }
  }

  async put(key: string, body: Readable, _opts: PutOpts): Promise<PutResult> {
    const target = this.fullPath(key);
    const tmp = `${target}.uploading-${randomBytes(4).toString("hex")}`;
    let bytesWritten = 0;
    let uploadStarted = false;

    await this.withSftp(async (sftp, signal) => {
      await this.ensureDir(sftp, posix.dirname(target), signal);
      signal.throwIfAborted();

      await new Promise<void>((resolve, reject) => {
        // `highWaterMark` is the throughput fix, and it is not a micro-optimisation.
        //
        // ssh2's SFTP WriteStream issues ONE `sftp.write()` per `_write` and waits
        // for the server's status reply before the next — so with the stream default
        // (16 KB) the upload runs at one 16-32 KB packet per round trip. On a 20 ms
        // link that is under 2 MB/s no matter how fast either end is, which is the
        // ~1.7 MB/s measured in #633 and the reason a 110 GB dump could not finish.
        //
        // Node calls `_writev` whenever more than one chunk is queued, and ssh2's
        // `_writev` fires every queued write CONCURRENTLY (each SFTP request carries
        // its own id, so they pipeline). Raising the buffer therefore raises the
        // number of requests in flight — the same trick `fastPut` uses with its
        // concurrency:64 — without reaching past the public stream API.
        //
        // This buffer is ALSO the backpressure boundary the artifact stream pushes
        // against, so it is a deliberate memory ceiling per upload, not a guess.
        uploadStarted = true;
        const ws = sftp.createWriteStream(tmp, { highWaterMark: UPLOAD_BUFFER_BYTES, autoClose: false });
        let lastProgressAt = Date.now();
        let settled = false;
        let finishedWriting = false;

        let watchdog: ReturnType<typeof setInterval> | undefined;

        const onSettled: Array<() => void> = [];
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (watchdog) clearInterval(watchdog);
          for (const stop of onSettled) stop();
          // One last read, so a fast upload that finished inside a single tracker
          // interval still reports the bytes it actually stored.
          const acked = (ws as unknown as { bytesWritten?: number }).bytesWritten ?? 0;
          if (acked > bytesWritten) bytesWritten = acked;
          if (err) {
            ws.destroy();
            body.destroy();
            reject(err);
          } else {
            resolve();
          }
        };

        // A wedged upload used to hang the run — and the worker slot behind it —
        // with no error and no close, leaving a `.uploading-*` temp file frozen at
        // a fixed size (#516). This bound is deliberately cause-agnostic: it says
        // nothing about WHY the bytes stopped, only that they did.
        watchdog = setInterval(() => {
          if (settled || Date.now() - lastProgressAt <= TRANSFER_IDLE_TIMEOUT_MS) return;
          finish(
            new Error(
              `SFTP upload stalled: no write progress for ${TRANSFER_IDLE_TIMEOUT_MS / 1000}s ` +
                `(wrote ${bytesWritten} bytes so far). Retry; if it recurs, check both ends — ` +
                `whether the source is still producing bytes, and the destination's SFTP subsystem.`,
            ),
          );
        }, UPLOAD_STALL_PROBE_MS);
        (watchdog as { unref?: () => void }).unref?.();

        ws.on("error", (err: Error) => finish(err));
        ws.on("finish", () => { finishedWriting = true; ws.destroy(); });
        ws.on("close", () => finish(finishedWriting ? undefined : new Error("SFTP upload closed before all bytes were written")));
        const onAbort = () => finish(signal.reason ?? new Error("SFTP connection closed"));
        signal.addEventListener("abort", onAbort, { once: true });
        onSettled.push(() => signal.removeEventListener("abort", onAbort));
        // Progress is measured at the WRITE side (`ws`), not by counting bytes read
        // out of `body`. Those are different questions: with a fast producer and a
        // dead destination, bytes leave `body` into the write buffer and the stall
        // watchdog sees healthy "progress" for as long as that buffer keeps
        // accepting. `ws.bytesWritten` only advances when the server has
        // acknowledged a write, which is the only evidence the upload is moving.
        // It is also the number this function returns, so a reported byte count now
        // means "stored", not "handed over".
        const trackProgress = setInterval(() => {
          const acked = (ws as unknown as { bytesWritten?: number }).bytesWritten ?? 0;
          if (acked <= bytesWritten) return;
          bytesWritten = acked;
          lastProgressAt = Date.now();
        }, 1000);
        (trackProgress as { unref?: () => void }).unref?.();
        onSettled.push(() => clearInterval(trackProgress));
        body.on("error", (err) => finish(err));
        body.on("close", () => {
          if (!body.readableEnded) finish(new Error("SFTP upload source closed prematurely"));
        });
        if (signal.aborted) return onAbort();
        body.pipe(ws);
      });

      // Atomic finalize.
      await sftpRequest("upload finalization", (done) => {
        sftp.rename(tmp, target, (err) => {
          if (!err) return done();
          // POSIX rename refuses to overwrite on some servers. Try
          // unlink + rename as the fallback.
          sftp.unlink(target, () => {
            sftp.rename(tmp, target, done);
          });
        });
      }, signal);
    }).catch(async (error) => {
      body.destroy();
      if (!uploadStarted) throw error;
      // The upload connection may already be dead. Reconnect with a deadline;
      // a failed cleanup must neither mask the upload error nor hold the worker.
      await this.withSftp(
        (sftp, signal) => this.unlinkIfPresent(sftp, tmp, signal, "temporary upload cleanup"),
        SFTP_CONTROL_TIMEOUT_MS,
      ).catch((cleanupError) => {
        console.warn(`[sftp] Could not reclaim temporary upload ${tmp}: ${safeErrorMessage(cleanupError)}`);
      });
      throw error;
    });

    return { bytesWritten };
  }

  async get(key: string): Promise<Readable> {
    const target = this.fullPath(key);
    const out = new PassThrough();
    out.on("error", () => {});
    const cancelled = new AbortController();
    out.once("close", () => {
      if (!out.readableEnded) cancelled.abort(new Error("SFTP download consumer closed early"));
    });
    // Keep the shared connection lifecycle until every remote byte is handed
    // off. A dropped SSH channel must fail the reader, not leave restore waiting
    // forever for an EOF that the disconnected server can no longer send.
    void this.withSftp(async (sftp, signal) => {
      const source = sftp.createReadStream(target);
      const onAbort = () => source.destroy(signal.reason as Error);
      signal.addEventListener("abort", onAbort, { once: true });
      let idle: ReturnType<typeof setTimeout> | undefined;
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => source.destroy(new Error("SFTP download stalled: no read progress for 600s")), TRANSFER_IDLE_TIMEOUT_MS);
        idle.unref?.();
      };
      source.on("data", touch);
      out.on("drain", touch);
      touch();
      try {
        await pipeline(source, out);
      } finally {
        clearTimeout(idle);
        source.off("data", touch);
        out.off("drain", touch);
        signal.removeEventListener("abort", onAbort);
      }
    }, undefined, cancelled.signal).catch(error => out.destroy(error as Error));
    return out;
  }

  async head(key: string): Promise<HeadInfo | null> {
    const target = this.fullPath(key);
    return this.withSftp(
        (sftp, signal) =>
          sftpRequest<HeadInfo | null>("file stat", (done) => {
            sftp.stat(target, (err, stats) => {
              if (err) {
                const code = (err as { code?: number }).code;
                if (code === 2) return done(null, null); // SFTP_STATUS_NO_SUCH_FILE
                return done(err);
              }
              done(null, {
                sizeBytes: stats.size,
                uploadedAt: new Date(stats.mtime * 1000),
              });
            });
          }, signal),
      );
  }

  async list(prefix: string, opts?: ListOpts): Promise<ListPage> {
    const root = this.fullPath(prefix);
    const limit = opts?.limit ?? 1000;
    const entries: ListPage["entries"] = [];

    await this.withSftp(async (sftp, signal) => {
      const walk = async (dir: string, relBase: string): Promise<void> => {
        const dirents = await sftpRequest<
          Array<{ filename: string; longname: string; attrs: { isDirectory(): boolean; isFile(): boolean; size: number; mtime: number } }>
        >("directory listing", (done) => {
          sftp.readdir(dir, (err, list) => {
            if (err) {
              const code = (err as { code?: number }).code;
              if (code === 2) return done(null, []); // missing dir = empty
              return done(err);
            }
            done(null, list);
          });
        }, signal);

        for (const dirent of dirents) {
          if (entries.length >= limit) return;
          const childRel = posix.join(relBase, dirent.filename);
          const childAbs = posix.join(dir, dirent.filename);
          if (dirent.attrs.isDirectory()) {
            await walk(childAbs, childRel);
          } else if (dirent.attrs.isFile()) {
            entries.push({
              key: posix.join(prefix, childRel),
              size: dirent.attrs.size,
              uploadedAt: new Date(dirent.attrs.mtime * 1000),
            });
          }
        }
      };
      await walk(root, "");
    });

    return { entries };
  }

  async delete(key: string): Promise<void> {
    const target = this.fullPath(key);
    await this.withSftp(
      (sftp, signal) => this.unlinkIfPresent(sftp, target, signal),
    );
  }

  async deleteMany(keys: string[]): Promise<{
    deleted: string[];
    failed: Array<{ key: string; error: string }>;
  }> {
    if (keys.length === 0) return { deleted: [], failed: [] };
    const deleted: string[] = [];
    const failed: Array<{ key: string; error: string }> = [];

    await this.withSftp(async (sftp, signal) => {
      for (const key of keys) {
        // eslint-disable-next-line no-await-in-loop
        try {
          await this.unlinkIfPresent(sftp, this.fullPath(key), signal);
          deleted.push(key);
        } catch (error) {
          failed.push({ key, error: safeErrorMessage(error) });
        }
      }
    });

    return { deleted, failed };
  }
}

// Both `sftp` and `openship_server` resolve to the SAME implementation —
// the apps/api layer hydrates openship_server rows with the user's
// `servers` table credentials before reaching this point, so the
// adapter sees a normal SFTP row in both cases.
registerDestination("sftp", (row) => new SftpDestinationImpl(row));
registerDestination("openship_server", (row) => new SftpDestinationImpl(row));
