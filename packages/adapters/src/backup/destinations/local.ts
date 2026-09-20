/**
 * LocalDestination — filesystem-backed backup storage. Useful for
 * dev/test and self-hosted users with a separate mounted disk on the
 * API host. Gated in cloud mode via the BACKUP_ALLOW_LOCAL_DESTINATION
 * env var (enforced at the apps/api layer, not here — adapters don't
 * read env directly so they stay testable).
 *
 * Atomic uploads via tmp/<runId> + fs.rename within the destination
 * root (POSIX atomic on same filesystem).
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { dirname, join, normalize, posix, resolve } from "node:path";
import { Readable, pipeline } from "node:stream";
import { promisify } from "node:util";
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

const pipelineP = promisify(pipeline);

const CAPS: ReadonlySet<DestinationCapability> = new Set<DestinationCapability>([
  "streamingPut",
  "streamingGet",
]);

class LocalDestinationImpl implements BackupDestination {
  readonly kind = "local" as const;
  readonly capabilities = CAPS;

  private readonly root: string;
  /**
   * Where artifacts written BEFORE `pathPrefix` moved out of the key builder live, or
   * null when this destination has no prefix and the two are the same place.
   */
  private readonly legacyRoot: string | null;

  constructor(row: BackupDestinationRow) {
    if (!row.endpoint) {
      throw new Error(`LocalDestination "${row.name}" has no endpoint (root path) configured`);
    }
    // Resolve to an absolute path + normalize. The path stays as configured — the user
    // is trusted here since the destination is theirs (and gated at the api layer in
    // cloud mode).
    //
    // `pathPrefix` IS applied, like s3.fullKey() and sftp.fullPath() do. It used to be
    // honored only by accident, because the key builder injected it into every key; now
    // that keys are destination-relative, a local destination with a prefix would
    // otherwise stop nesting under it — silently, and only for new runs.
    const base = resolve(row.endpoint);
    const prefix = (row.pathPrefix ?? "").replace(/^\/+|\/+$/g, "");
    this.root = prefix ? resolve(base, prefix) : base;
    this.legacyRoot = prefix ? base : null;
  }

  private resolveKey(key: string): string {
    // Defend against `..` traversal even within trusted destinations.
    const normalized = normalize(key);
    if (normalized.startsWith("..") || normalized.includes(`${normalize("../")}`)) {
      throw new Error(`Invalid key (traversal): ${key}`);
    }
    return join(this.root, normalized);
  }

  /**
   * The path to READ `key` from, preferring the current layout and falling back to the
   * pre-prefix one.
   *
   * A run captured before this change recorded a key that already CONTAINS the prefix
   * (the key builder put it there), and its bytes sit at `endpoint/<prefix>/<key…>` —
   * which is `legacyRoot + key`, not `root + key`. Resolving it against the new root
   * would look for `endpoint/<prefix>/<prefix>/…` and find nothing, so an existing
   * restore point would quietly become unrestorable.
   *
   * Deliberately an existence check rather than a "does the key already start with the
   * prefix" string test: the key builder's first literal segment is `openship`, so a
   * destination whose prefix is also `openship` would make that test ambiguous. The
   * filesystem is not ambiguous. Reads only — `put` always writes the current layout,
   * so this shim shrinks to nothing as old runs age out of retention.
   */
  private async resolveKeyForRead(key: string): Promise<string> {
    const current = this.resolveKey(key);
    if (this.legacyRoot === null) return current;
    try {
      await fs.access(current);
      return current;
    } catch {
      const legacy = join(this.legacyRoot, normalize(key));
      try {
        await fs.access(legacy);
        return legacy;
      } catch {
        return current; // neither exists; report against the current layout
      }
    }
  }

  async preflight(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await fs.mkdir(this.root, { recursive: true });
      const probeKey = `.openship-probe-${randomBytes(6).toString("hex")}`;
      const probePath = join(this.root, probeKey);
      await fs.writeFile(probePath, "ok");
      await fs.readFile(probePath);
      await fs.unlink(probePath);
      return { ok: true };
    } catch (err) {
      const message = safeErrorMessage(err);
      return { ok: false, reason: message };
    }
  }

  async put(key: string, body: Readable, opts: PutOpts): Promise<PutResult> {
    const targetPath = this.resolveKey(key);
    await fs.mkdir(dirname(targetPath), { recursive: true });

    const tmpPath = `${targetPath}.tmp-${randomBytes(4).toString("hex")}`;
    const hash = createHash("sha256");
    let bytesWritten = 0;

    const counterAndHasher = new (await import("node:stream")).Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        bytesWritten += chunk.byteLength;
        cb(null, chunk);
      },
    });

    let digest: string;
    try {
      await pipelineP(body, counterAndHasher, createWriteStream(tmpPath));
      digest = hash.digest("hex");
      // `PutOpts.sha256` is a gate. Checked BEFORE the rename so a body that
      // arrived corrupt never becomes a readable object — a half-good artifact
      // that restore later trusts is worse than a failed backup.
      const expected = opts.sha256?.trim().replace(/^sha256:/i, "").toLowerCase();
      if (expected && expected !== digest) {
        throw new Error(
          `sha256 mismatch writing ${key}: caller declared ${expected}, bytes hashed to ${digest}`,
        );
      }
      // POSIX atomic rename.
      await fs.rename(tmpPath, targetPath);
    } catch (err) {
      // Clean up the partial file.
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }

    return { bytesWritten, etag: digest };
  }

  async get(key: string): Promise<Readable> {
    return createReadStream(await this.resolveKeyForRead(key));
  }

  async head(key: string): Promise<HeadInfo | null> {
    try {
      const stat = await fs.stat(await this.resolveKeyForRead(key));
      return {
        sizeBytes: stat.size,
        uploadedAt: stat.mtime,
      };
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code === "ENOENT") return null;
      throw err;
    }
  }

  async list(prefix: string, opts?: ListOpts): Promise<ListPage> {
    const root = await this.resolveKeyForRead(prefix);
    const entries: ListPage["entries"] = [];
    const limit = opts?.limit ?? 1000;

    async function walk(dir: string, relBase: string): Promise<void> {
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e?.code === "ENOENT") return;
        throw err;
      }
      for (const dirent of dirents) {
        if (entries.length >= limit) return;
        const childRel = posix.join(relBase, dirent.name);
        const childAbs = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          await walk(childAbs, childRel);
        } else if (dirent.isFile()) {
          const stat = await fs.stat(childAbs);
          entries.push({
            key: posix.join(prefix, childRel),
            size: stat.size,
            uploadedAt: stat.mtime,
          });
        }
      }
    }
    await walk(root, "");
    return { entries };
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(await this.resolveKeyForRead(key));
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code !== "ENOENT") throw err;
    }
  }

  async deleteMany(keys: string[]): Promise<{
    deleted: string[];
    failed: Array<{ key: string; error: string }>;
  }> {
    const deleted: string[] = [];
    const failed: Array<{ key: string; error: string }> = [];
    for (const key of keys) {
      try {
        await this.delete(key);
        deleted.push(key);
      } catch (err) {
        failed.push({
          key,
          error: safeErrorMessage(err),
        });
      }
    }
    return { deleted, failed };
  }
}

registerDestination("local", (row) => new LocalDestinationImpl(row));
