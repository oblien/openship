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
    if (candidate !== root && !candidate.startsWith(root + "/")) {
      throw new Error(
        `SFTP key escapes destination root (${this.rootPath}): ${key}`,
      );
    }
    return candidate;
  }

  // ── Connection helper ────────────────────────────────────────────────

  private async withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const client = new Client();
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        try {
          client.end();
        } catch {
          // already ended
        }
      };
      client
        .on("ready", () => {
          client.sftp((err, sftp) => {
            if (err) {
              cleanup();
              reject(err);
              return;
            }
            fn(sftp).then(
              (val) => {
                cleanup();
                resolve(val);
              },
              (e) => {
                cleanup();
                reject(e);
              },
            );
          });
        })
        .on("error", (err) => {
          cleanup();
          reject(err);
        })
        .connect(this.conn);
    });
  }

  // ── Recursive mkdir (SFTP has no mkdir -p) ───────────────────────────

  private async ensureDir(sftp: SFTPWrapper, dir: string): Promise<void> {
    const parts = dir.split("/").filter(Boolean);
    let current = dir.startsWith("/") ? "" : ".";
    for (const part of parts) {
      current = current === "" ? `/${part}` : posix.join(current, part);
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(current, (err) => {
          if (!err) return resolve();
          // EEXIST / "Failure" / code 4 = already exists. We can't
          // reliably check by code (depends on server), so try stat
          // and treat-as-ok if it's a directory.
          sftp.stat(current, (statErr, stats) => {
            if (statErr) return reject(err);
            if (stats.isDirectory()) return resolve();
            reject(new Error(`${current} exists but is not a directory`));
          });
        });
      });
    }
  }

  // ── BackupDestination interface ──────────────────────────────────────

  async preflight(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const probeName = `.openship-probe-${randomBytes(6).toString("hex")}`;
      await this.withSftp(async (sftp) => {
        await this.ensureDir(sftp, this.rootPath);
        const probePath = posix.join(this.rootPath, probeName);
        await new Promise<void>((resolve, reject) => {
          const ws = sftp.createWriteStream(probePath);
          ws.on("error", reject);
          ws.on("close", () => resolve());
          ws.end("ok");
        });
        await new Promise<void>((resolve, reject) =>
          sftp.unlink(probePath, (err) => (err ? reject(err) : resolve())),
        );
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

    await this.withSftp(async (sftp) => {
      await this.ensureDir(sftp, posix.dirname(target));

      await new Promise<void>((resolve, reject) => {
        const ws = sftp.createWriteStream(tmp);
        ws.on("error", reject);
        ws.on("close", () => resolve());
        body.on("data", (chunk: Buffer) => {
          bytesWritten += chunk.byteLength;
        });
        body.on("error", (err) => {
          ws.destroy();
          reject(err);
        });
        body.pipe(ws);
      });

      // Atomic finalize.
      await new Promise<void>((resolve, reject) => {
        sftp.rename(tmp, target, (err) => {
          if (!err) return resolve();
          // POSIX rename refuses to overwrite on some servers. Try
          // unlink + rename as the fallback.
          sftp.unlink(target, () => {
            sftp.rename(tmp, target, (err2) =>
              err2 ? reject(err2) : resolve(),
            );
          });
        });
      });
    });

    return { bytesWritten };
  }

  async get(key: string): Promise<Readable> {
    // The SFTP read stream needs the connection to outlive the
    // returned Readable. We pipe through a PassThrough and close the
    // client when the pass-through ends or errors.
    const target = this.fullPath(key);
    const out = new PassThrough();

    const client = new Client();
    let ended = false;
    const close = () => {
      if (ended) return;
      ended = true;
      try {
        client.end();
      } catch {
        // already ended
      }
    };

    client
      .on("ready", () => {
        client.sftp((err, sftp) => {
          if (err) {
            out.destroy(err);
            close();
            return;
          }
          const rs = sftp.createReadStream(target);
          rs.on("error", (e: Error) => {
            out.destroy(e);
            close();
          });
          rs.on("end", close);
          rs.pipe(out);
        });
      })
      .on("error", (err) => {
        out.destroy(err);
        close();
      })
      .connect(this.conn);

    out.on("close", close);
    return out;
  }

  async head(key: string): Promise<HeadInfo | null> {
    const target = this.fullPath(key);
    try {
      return await this.withSftp(
        (sftp) =>
          new Promise<HeadInfo | null>((resolve, reject) => {
            sftp.stat(target, (err, stats) => {
              if (err) {
                const code = (err as { code?: number }).code;
                if (code === 2) return resolve(null); // SFTP_STATUS_NO_SUCH_FILE
                return reject(err);
              }
              resolve({
                sizeBytes: stats.size,
                uploadedAt: new Date(stats.mtime * 1000),
              });
            });
          }),
      );
    } catch {
      return null;
    }
  }

  async list(prefix: string, opts?: ListOpts): Promise<ListPage> {
    const root = this.fullPath(prefix);
    const limit = opts?.limit ?? 1000;
    const entries: ListPage["entries"] = [];

    await this.withSftp(async (sftp) => {
      const walk = async (dir: string, relBase: string): Promise<void> => {
        const dirents = await new Promise<
          Array<{ filename: string; longname: string; attrs: { isDirectory(): boolean; isFile(): boolean; size: number; mtime: number } }>
        >((resolve, reject) => {
          sftp.readdir(dir, (err, list) => {
            if (err) {
              const code = (err as { code?: number }).code;
              if (code === 2) return resolve([]); // missing dir = empty
              return reject(err);
            }
            resolve(list);
          });
        });

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
      (sftp) =>
        new Promise<void>((resolve, reject) =>
          sftp.unlink(target, (err) => {
            if (!err) return resolve();
            const code = (err as { code?: number }).code;
            if (code === 2) return resolve(); // already gone
            reject(err);
          }),
        ),
    );
  }

  async deleteMany(keys: string[]): Promise<{
    deleted: string[];
    failed: Array<{ key: string; error: string }>;
  }> {
    if (keys.length === 0) return { deleted: [], failed: [] };
    const deleted: string[] = [];
    const failed: Array<{ key: string; error: string }> = [];

    await this.withSftp(async (sftp) => {
      for (const key of keys) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => {
          sftp.unlink(this.fullPath(key), (err) => {
            if (!err) {
              deleted.push(key);
              return resolve();
            }
            const code = (err as { code?: number }).code;
            if (code === 2) {
              deleted.push(key); // missing = "successfully" deleted
            } else {
              failed.push({ key, error: err.message });
            }
            resolve();
          });
        });
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
