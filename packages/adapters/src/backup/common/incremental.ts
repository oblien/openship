import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import {
  BACKUP_CHUNK_BYTES,
  MAX_BACKUP_CHUNKS,
  incrementalBackupStorage,
  type BackupChunk,
  type IncrementalBackupStorage,
  type StoredBackupArtifact,
} from "@repo/core";
import type { Artifact, BackupDestination, HeadInfo } from "../types";
import { artifactKey, runPrefix } from "./key-builder";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const sha256 = (body: Buffer) => createHash("sha256").update(body).digest("hex");

export interface RecordedBackupArtifact extends StoredBackupArtifact {
  name: string;
  sha256: string;
  payloadKind: Artifact["payloadKind"];
  metadata: Record<string, unknown>;
}

async function readBounded(body: Readable, size: number): Promise<Buffer> {
  const buffers: Buffer[] = [];
  let bytes = 0;
  for await (const value of body) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > size) throw new Error("Backup object is larger than its recorded size");
    buffers.push(chunk);
  }
  if (bytes !== size) throw new Error("Backup object is shorter than its recorded size");
  return Buffer.concat(buffers, bytes);
}

async function* blocks(body: Readable): AsyncGenerator<Buffer> {
  let buffer = Buffer.allocUnsafe(BACKUP_CHUNK_BYTES);
  let used = 0;
  for await (const value of body) {
    const input = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < input.length) {
      const count = Math.min(input.length - offset, buffer.length - used);
      input.copy(buffer, used, offset, offset + count);
      used += count;
      offset += count;
      if (used === buffer.length) {
        yield buffer;
        buffer = Buffer.allocUnsafe(BACKUP_CHUNK_BYTES);
        used = 0;
      }
    }
  }
  if (used) yield buffer.subarray(0, used);
}

function indexBody(
  artifact: Pick<StoredBackupArtifact, "sizeBytes" | "sha256">,
  chunks: BackupChunk[],
) {
  // jsonb does not preserve object key order. Reconstruct the wire schema in a
  // stable order before hashing, including blocks loaded from an older run.
  return Buffer.from(
    JSON.stringify({
      format: "chunks-v1",
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      chunks: chunks.map((chunk) => ({
        key: chunk.key,
        sizeBytes: chunk.sizeBytes,
        sha256: chunk.sha256,
        contentBytes: chunk.contentBytes,
        contentSha256: chunk.contentSha256,
      })),
    }),
  );
}

async function putBuffer(destination: BackupDestination, key: string, body: Buffer) {
  const digest = sha256(body);
  const result = await destination.put(key, Readable.from([body]), {
    size: body.length,
    sha256: digest,
  });
  if (
    result.bytesWritten !== body.length ||
    (result.etag && /^[a-f0-9]{64}$/i.test(result.etag) && result.etag.toLowerCase() !== digest)
  )
    throw new Error(`Backup object ${key} changed in transit`);
  return digest;
}

/**
 * Fixed-size blocks of the producer's stream, independently gzip-compressed.
 * Only blocks from this policy/service/destination's previous snapshot are
 * reusable. The caller holds the policy lock until the new manifest is durable.
 * Every snapshot records the complete ordered block list, never a delta chain.
 */
export async function uploadIncrementalArtifact(
  destination: BackupDestination,
  baseKey: { projectSlug: string; serviceName: string; runId: string },
  artifact: Artifact,
  previous: StoredBackupArtifact[],
  uploadedKeys: string[],
  onBytes?: (bytes: number) => void,
): Promise<RecordedBackupArtifact> {
  const reusable = new Map<string, BackupChunk>();
  for (const old of previous) {
    for (const chunk of incrementalBackupStorage(old)?.chunks ?? [])
      reusable.set(chunk.contentSha256, chunk);
  }
  const verified = new Map<string, BackupChunk>();
  const chunks: BackupChunk[] = [];
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let uploadedBytes = 0;
  for await (const content of blocks(artifact.stream)) {
    if (chunks.length >= MAX_BACKUP_CHUNKS)
      throw new Error("Incremental backup exceeds the supported block count");
    hash.update(content);
    sizeBytes += content.length;
    const contentSha256 = sha256(content);
    let chunk = verified.get(contentSha256);
    const old = reusable.get(contentSha256);
    if (!chunk && old && old.contentBytes === content.length) {
      const head = await destination.head(old.key);
      if (head?.sizeBytes === old.sizeBytes) {
        try {
          const stored = await readBounded(await destination.get(old.key), old.sizeBytes);
          if (sha256(stored) === old.sha256) {
            const decoded = await decompress(stored, { maxOutputLength: content.length });
            if (decoded.equals(content)) chunk = old;
          }
        } catch {
          // The previous object may disappear after HEAD, be truncated, or fail
          // to decompress. Upload the current source to this run's own key; a
          // damaged old snapshot must not poison the next restore point.
        }
      }
    }
    if (!chunk) {
      const body = await compress(content);
      const key = `${runPrefix(baseKey)}/blocks/${contentSha256}.gz`;
      uploadedKeys.push(key);
      const digest = await putBuffer(destination, key, body);
      uploadedBytes += body.length;
      chunk = {
        key,
        sizeBytes: body.length,
        sha256: digest,
        contentBytes: content.length,
        contentSha256,
      };
    }
    verified.set(contentSha256, chunk);
    chunks.push(chunk);
    onBytes?.(uploadedBytes);
  }
  if (!sizeBytes) throw new Error(`Backup captured nothing: ${artifact.name} produced no bytes`);
  const digest = hash.digest("hex");
  const key = artifactKey(baseKey, artifact.name + ".chunks.json");
  const body = indexBody({ sizeBytes, sha256: digest }, chunks);
  const storage: IncrementalBackupStorage = {
    format: "chunks-v1",
    indexSizeBytes: body.length,
    indexSha256: sha256(body),
    uploadedBytes: uploadedBytes + body.length,
    chunks,
  };
  const recorded = {
    name: artifact.name,
    key,
    sizeBytes,
    sha256: digest,
    payloadKind: artifact.payloadKind,
    metadata: { ...artifact.metadata, storage },
  };
  incrementalBackupStorage(recorded);
  uploadedKeys.push(key);
  await putBuffer(destination, key, body);
  onBytes?.(storage.uploadedBytes);
  return recorded;
}

async function checkIndex(
  destination: BackupDestination,
  artifact: StoredBackupArtifact,
  storage: IncrementalBackupStorage,
) {
  const expected = indexBody(artifact, storage.chunks);
  if (expected.length !== storage.indexSizeBytes || sha256(expected) !== storage.indexSha256)
    throw new Error(`Incremental backup index disagrees with the recorded backup: ${artifact.key}`);
  const body = await readBounded(await destination.get(artifact.key), storage.indexSizeBytes);
  if (sha256(body) !== storage.indexSha256)
    throw new Error(`Incremental backup index failed integrity check: ${artifact.key}`);
}

/** The virtual artifact is the original tar/dump; storage encoding stays here. */
export async function headBackupArtifact(
  destination: BackupDestination,
  artifact: StoredBackupArtifact,
): Promise<HeadInfo | null> {
  const storage = incrementalBackupStorage(artifact);
  const head = await destination.head(artifact.key);
  if (!storage || !head) return head;
  await checkIndex(destination, artifact, storage);
  for (const chunk of new Map(storage.chunks.map((chunk) => [chunk.key, chunk])).values()) {
    const block = await destination.head(chunk.key);
    if (!block || block.sizeBytes !== chunk.sizeBytes)
      throw new Error(`Incremental backup block is missing or incomplete: ${chunk.key}`);
  }
  return { ...head, sizeBytes: artifact.sizeBytes };
}

export async function openBackupArtifact(
  destination: BackupDestination,
  artifact: StoredBackupArtifact,
): Promise<Readable> {
  const storage = incrementalBackupStorage(artifact);
  if (!storage) return destination.get(artifact.key);
  await checkIndex(destination, artifact, storage);
  return Readable.from(
    (async function* () {
      for (const chunk of storage.chunks) {
        const body = await readBounded(await destination.get(chunk.key), chunk.sizeBytes);
        if (sha256(body) !== chunk.sha256)
          throw new Error(`Incremental backup block failed integrity check: ${chunk.key}`);
        const content = await decompress(body, { maxOutputLength: chunk.contentBytes });
        if (content.length !== chunk.contentBytes || sha256(content) !== chunk.contentSha256)
          throw new Error(`Incremental backup block content failed integrity check: ${chunk.key}`);
        yield content;
      }
    })(),
    { objectMode: false },
  );
}
