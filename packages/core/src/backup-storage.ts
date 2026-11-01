/** Storage metadata is shared by capture, restore, retention, and accounting. */
export const BACKUP_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_BACKUP_CHUNKS = 131_072;
export const MAX_BACKUP_INDEX_BYTES = 32 * 1024 * 1024;

export interface BackupChunk {
  key: string;
  /** Size and digest of the gzip object at the destination. */
  sizeBytes: number;
  sha256: string;
  contentBytes: number;
  contentSha256: string;
}

export interface IncrementalBackupStorage {
  format: "chunks-v1";
  indexSizeBytes: number;
  indexSha256: string;
  uploadedBytes: number;
  chunks: BackupChunk[];
}

export interface StoredBackupArtifact {
  key: string;
  sizeBytes: number;
  sha256?: string | null;
  metadata?: Record<string, unknown>;
}

const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positiveSize = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

export function incrementalBackupStorage(
  artifact: StoredBackupArtifact,
): IncrementalBackupStorage | null {
  const value = artifact.metadata?.storage;
  if (value === undefined) return null;
  const storage = value as IncrementalBackupStorage | null;
  if (
    !storage ||
    storage.format !== "chunks-v1" ||
    !positiveSize(storage.indexSizeBytes) ||
    storage.indexSizeBytes > MAX_BACKUP_INDEX_BYTES ||
    !digest(storage.indexSha256) ||
    !positiveSize(storage.uploadedBytes) ||
    storage.uploadedBytes < storage.indexSizeBytes ||
    !Array.isArray(storage.chunks) ||
    storage.chunks.length === 0 ||
    storage.chunks.length > MAX_BACKUP_CHUNKS ||
    !positiveSize(artifact.sizeBytes) ||
    !digest(artifact.sha256)
  )
    throw new Error(`Invalid incremental backup metadata for ${artifact.key}`);
  let total = 0;
  const objects = new Map<string, BackupChunk>();
  for (const chunk of storage.chunks) {
    if (
      !chunk ||
      typeof chunk.key !== "string" ||
      !/^[a-zA-Z0-9._/-]+$/.test(chunk.key) ||
      chunk.key.startsWith("/") ||
      chunk.key.split("/").some((part) => !part || part === "." || part === "..") ||
      chunk.key === artifact.key ||
      !positiveSize(chunk.sizeBytes) ||
      chunk.sizeBytes > BACKUP_CHUNK_BYTES + 65_536 ||
      !digest(chunk.sha256) ||
      !digest(chunk.contentSha256) ||
      !positiveSize(chunk.contentBytes) ||
      chunk.contentBytes > BACKUP_CHUNK_BYTES
    )
      throw new Error(`Invalid incremental backup block in ${artifact.key}`);
    const existing = objects.get(chunk.key);
    if (
      existing &&
      (existing.sizeBytes !== chunk.sizeBytes ||
        existing.sha256 !== chunk.sha256 ||
        existing.contentBytes !== chunk.contentBytes ||
        existing.contentSha256 !== chunk.contentSha256)
    )
      throw new Error(`Conflicting incremental backup block in ${artifact.key}`);
    objects.set(chunk.key, chunk);
    total += chunk.contentBytes;
  }
  if (total !== artifact.sizeBytes)
    throw new Error(`Incremental backup size mismatch for ${artifact.key}`);
  return storage;
}

/** Every physical object a restore point needs; shared blocks appear only once. */
export function backupArtifactObjects(artifact: StoredBackupArtifact): Map<string, number> {
  const storage = incrementalBackupStorage(artifact);
  const objects = new Map<string, number>([
    [artifact.key, storage?.indexSizeBytes ?? artifact.sizeBytes],
  ]);
  for (const chunk of storage?.chunks ?? []) objects.set(chunk.key, chunk.sizeBytes);
  return objects;
}
