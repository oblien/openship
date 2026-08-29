/**
 * S3-compatible destination — one impl covers AWS S3, Cloudflare R2,
 * Wasabi, Backblaze B2 (S3 API), MinIO, DigitalOcean Spaces, Ceph,
 * Storj, and anything else that speaks the S3 protocol.
 *
 * Path-style addressing is forced when the endpoint isn't AWS (R2 etc.
 * require it). Multipart upload is handled by @aws-sdk/lib-storage's
 * `Upload` class — it buffers a few parts in memory (bounded), retries
 * transient errors, and emits progress events.
 *
 * Atomic uploads: lib-storage either completes the multipart upload
 * (all parts visible at once) or aborts it (nothing visible). Single
 * PUT is naturally atomic. Either way, restores never see partial bytes.
 */

import {
  CompleteMultipartUploadCommandOutput,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import { decryptCredential } from "../common/credentials";
import { registerDestination } from "../registry";
import { isAwsS3Endpoint, safeErrorMessage } from "@repo/core";
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
  "multipart",
  "presignedGet",
  "presignedPut",
  "serverSideCopy",
]);

const PRESIGN_TTL_DEFAULT = 60 * 60;
/**
 * Baseline multipart part size, and the memory budget that bounds the uploader.
 *
 * S3 caps an upload at **10,000 parts**, so a fixed part size is also a size ceiling:
 * 16 MiB × 10,000 is ~156 GiB, and exceeding it fails at `CompleteMultipartUpload` —
 * i.e. AFTER transferring every byte, hours into a large backup. That is the
 * fail-late-and-surprise-the-operator shape this module has been removing, so
 * `partSizeFor()` scales the part size up when the artifact's size is known.
 *
 * In-flight memory for one upload is `partSize × queueSize`, which is why the queue is
 * derived from a byte budget instead of being a fixed count: a bigger part size must buy
 * fewer concurrent parts, not more resident memory.
 */
const MULTIPART_PART_SIZE = 16 * 1024 * 1024;
const MULTIPART_MEMORY_BUDGET = 64 * 1024 * 1024;
/** Leave headroom under S3's hard 10,000-part limit rather than landing exactly on it. */
const MULTIPART_MAX_PARTS = 9_000;

/**
 * Part size for a stream whose size we do NOT know — which is every database dump,
 * since a dump is piped straight through and has no `sizeHint`.
 *
 * This constant IS the ceiling, in disguise: the largest artifact such an upload can
 * finish is `size × MULTIPART_MAX_PARTS`. At the 16 MiB baseline that was ~140 GiB,
 * and #633's dump was 110 GB — close enough that it was a live risk rather than a
 * theoretical one, and it failed at `CompleteMultipartUpload`, i.e. after paying for
 * every byte.
 *
 * 32 MiB doubles the reach to ~281 GiB at IDENTICAL in-flight memory, because
 * `queueSizeFor` derives concurrency from the same byte budget — the part count halves
 * as the part size doubles. Going further would buy reach with resident memory, and
 * this module exists because an unbounded byte plane OOM'd the API, so that trade is
 * refused here. Past this point the honest answer is `abortIfPastCeiling`, which fails
 * early with a reason instead of late with an opaque S3 error.
 */
const UNKNOWN_SIZE_PART_SIZE = 32 * 1024 * 1024;

/** Part size that keeps an artifact under the part limit. Exported for test. */
export function partSizeFor(sizeBytes: number | undefined): number {
  if (!sizeBytes || sizeBytes <= 0) return UNKNOWN_SIZE_PART_SIZE;
  return Math.max(MULTIPART_PART_SIZE, Math.ceil(sizeBytes / MULTIPART_MAX_PARTS));
}

/** Concurrent parts that fit the memory budget at this part size. Exported for test. */
export function queueSizeFor(partSize: number): number {
  return Math.max(1, Math.floor(MULTIPART_MEMORY_BUDGET / partSize));
}

/**
 * The largest artifact an upload at this part size can actually complete.
 *
 * Exported because it is the number an operator needs when a backup fails for this
 * reason, and because a limit nothing can name is a limit nobody can plan around.
 */
export function partLimitCeiling(partSize: number): number {
  return partSize * MULTIPART_MAX_PARTS;
}

/** Bytes as whole GiB, for an operator-facing message. */
function gib(bytes: number): number {
  return Math.round(bytes / (1024 * 1024 * 1024));
}

class S3DestinationImpl implements BackupDestination {
  readonly kind = "s3_compatible" as const;
  readonly capabilities = CAPS;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(row: BackupDestinationRow) {
    if (!row.bucket) {
      throw new Error(`S3Destination "${row.name}" missing bucket`);
    }
    const accessKeyId = decryptCredential(row.accessKeyIdEnc);
    const secretAccessKey = decryptCredential(row.secretAccessKeyEnc);
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(`S3Destination "${row.name}" missing access credentials`);
    }
    // Force path-style for non-AWS endpoints (R2, MinIO, etc.). Shared with the
    // app-side object-storage binding so a bucket can't be addressed one way by
    // backups and another way by the app writing to it.
    const isAws = isAwsS3Endpoint(row.endpoint);

    this.client = new S3Client({
      endpoint: row.endpoint ?? undefined,
      region: row.region ?? "auto",
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: !isAws,
    });
    this.bucket = row.bucket;
    this.prefix = (row.pathPrefix ?? "").replace(/^\/+|\/+$/g, "");
  }

  private fullKey(key: string): string {
    const cleaned = key.replace(/^\/+/, "");
    return this.prefix ? `${this.prefix}/${cleaned}` : cleaned;
  }

  async preflight(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const probeKey = this.fullKey(
      `.openship-probe-${Math.random().toString(36).slice(2, 10)}`,
    );
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: probeKey,
          Body: "ok",
          ContentType: "text/plain",
        }),
      );
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: probeKey }));
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: probeKey }));
      return { ok: true };
    } catch (err) {
      const message = safeErrorMessage(err);
      return { ok: false, reason: message };
    }
  }

  async put(key: string, body: Readable, opts: PutOpts): Promise<PutResult> {
    const fullKey = this.fullKey(key);
    const partSize = partSizeFor(opts.size);

    // Below-threshold: a single PutObject. For unknown-size streams, the
    // SDK's Upload class handles both single and multipart automatically.
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: fullKey,
        Body: body,
        ContentType: opts.contentType ?? "application/octet-stream",
        Metadata: opts.metadata,
      },
      // Derived, not fixed — see partSizeFor. An artifact whose size we know never trips
      // S3's 10,000-part limit; one we don't (a DB dump has no sizeHint) gets
      // UNKNOWN_SIZE_PART_SIZE, whose ceiling is enforced below rather than discovered
      // at CompleteMultipartUpload.
      partSize,
      queueSize: queueSizeFor(partSize),
      leavePartsOnError: false,
    });

    const ceiling = partLimitCeiling(partSize);
    let bytesWritten = 0;
    /**
     * Set when we abort for the part-limit ceiling, so `done()`'s rejection can be
     * replaced with the real reason. Without this the operator sees whatever the SDK
     * throws for a cancelled upload, which says nothing about why.
     */
    let ceilingError: Error | null = null;

    upload.on("httpUploadProgress", (progress) => {
      if (typeof progress.loaded === "number") bytesWritten = progress.loaded;
      // Fail as soon as completion is IMPOSSIBLE, not after paying for every byte.
      // S3 rejects a >10,000-part upload at CompleteMultipartUpload — the very last
      // call — so without this a 300 GB dump transfers for hours and then throws an
      // error that names neither the limit nor the remedy.
      if (!ceilingError && bytesWritten > ceiling) {
        ceilingError = new Error(
          `Artifact exceeds what one S3 multipart upload can hold at this part size: ` +
            `${gib(bytesWritten)} GiB transferred, ceiling ${gib(ceiling)} GiB ` +
            `(${MULTIPART_MAX_PARTS} parts × ${Math.round(partSize / (1024 * 1024))} MiB). ` +
            `Aborted early rather than failing at CompleteMultipartUpload after ` +
            `transferring everything. A source whose size is known scales its part size ` +
            `automatically; a streamed database dump cannot, so this artifact needs to be ` +
            `split or sent to a destination without a part limit.`,
        );
        void upload.abort().catch(() => {});
      }
    });

    let result: CompleteMultipartUploadCommandOutput;
    try {
      result = (await upload.done()) as CompleteMultipartUploadCommandOutput;
    } catch (err) {
      // Our abort surfaces as a generic cancellation; the ceiling is the real cause.
      if (ceilingError) throw ceilingError;
      throw err;
    }
    return {
      bytesWritten,
      etag: result.ETag?.replace(/"/g, "") ?? undefined,
    };
  }

  async get(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
    );
    if (!result.Body) {
      throw new Error(`No body in GetObject response for ${key}`);
    }
    // The SDK returns a web-style ReadableStream or a Node Readable
    // depending on runtime — normalize.
    const body = result.Body as Readable | NodeJS.ReadableStream;
    return body as Readable;
  }

  async head(key: string): Promise<HeadInfo | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      return {
        sizeBytes: result.ContentLength ?? 0,
        etag: result.ETag?.replace(/"/g, "") ?? undefined,
        uploadedAt: result.LastModified ?? new Date(),
        metadata: result.Metadata,
      };
    } catch (err: unknown) {
      const e = err as { $metadata?: { httpStatusCode?: number }; name?: string };
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return null;
      throw err;
    }
  }

  async list(prefix: string, opts?: ListOpts): Promise<ListPage> {
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.fullKey(prefix),
        MaxKeys: opts?.limit ?? 1000,
        ContinuationToken: opts?.continuationToken,
      }),
    );
    const entries = (result.Contents ?? []).map((obj) => ({
      // Strip the destination's own pathPrefix so the orchestrator sees
      // keys relative to the destination root.
      key: this.prefix && obj.Key?.startsWith(`${this.prefix}/`)
        ? obj.Key.slice(this.prefix.length + 1)
        : obj.Key ?? "",
      size: obj.Size ?? 0,
      uploadedAt: obj.LastModified ?? new Date(),
    }));
    return {
      entries,
      nextContinuationToken: result.NextContinuationToken,
    };
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
    } catch (err: unknown) {
      const e = err as { $metadata?: { httpStatusCode?: number } };
      if (e?.$metadata?.httpStatusCode === 404) return;
      throw err;
    }
  }

  async deleteMany(keys: string[]): Promise<{
    deleted: string[];
    failed: Array<{ key: string; error: string }>;
  }> {
    if (keys.length === 0) return { deleted: [], failed: [] };

    // S3 DeleteObjects accepts up to 1000 per call.
    const chunks: string[][] = [];
    for (let i = 0; i < keys.length; i += 1000) chunks.push(keys.slice(i, i + 1000));

    const deleted: string[] = [];
    const failed: Array<{ key: string; error: string }> = [];

    for (const chunk of chunks) {
      try {
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: chunk.map((k) => ({ Key: this.fullKey(k) })),
              Quiet: false,
            },
          }),
        );
        for (const okItem of result.Deleted ?? []) {
          if (okItem.Key) deleted.push(this.stripPrefix(okItem.Key));
        }
        for (const errItem of result.Errors ?? []) {
          if (errItem.Key) {
            failed.push({
              key: this.stripPrefix(errItem.Key),
              error: errItem.Message ?? errItem.Code ?? "Unknown",
            });
          }
        }
      } catch (err) {
        const message = safeErrorMessage(err);
        for (const k of chunk) failed.push({ key: k, error: message });
      }
    }
    return { deleted, failed };
  }

  async presignGet(key: string, ttlSec: number = PRESIGN_TTL_DEFAULT): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      { expiresIn: ttlSec },
    );
  }

  async presignPut(
    key: string,
    ttlSec: number = PRESIGN_TTL_DEFAULT,
    opts?: { contentType?: string },
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        ContentType: opts?.contentType ?? "application/octet-stream",
      }),
      { expiresIn: ttlSec },
    );
  }

  private stripPrefix(key: string): string {
    return this.prefix && key.startsWith(`${this.prefix}/`)
      ? key.slice(this.prefix.length + 1)
      : key;
  }
}

registerDestination("s3_compatible", (row) => new S3DestinationImpl(row));
