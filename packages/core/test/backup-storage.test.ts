import { describe, expect, it } from "vitest";
import {
  BACKUP_CHUNK_BYTES,
  MAX_BACKUP_CHUNKS,
  MAX_BACKUP_INDEX_BYTES,
  backupArtifactObjects,
  incrementalBackupStorage,
  type BackupChunk,
  type IncrementalBackupStorage,
  type StoredBackupArtifact,
} from "../src/backup-storage";
import { validatePolicyPayload } from "../src/backup-catalog";

const block = (): BackupChunk => ({
  key: "openship/app/data/old/blocks/content.gz",
  sizeBytes: 100,
  sha256: "a".repeat(64),
  contentBytes: 1000,
  contentSha256: "b".repeat(64),
});
const artifact = (chunks = [block()]): StoredBackupArtifact => ({
  key: "openship/app/data/new/data.tar.chunks.json",
  sizeBytes: chunks.reduce((sum, chunk) => sum + chunk.contentBytes, 0),
  sha256: "c".repeat(64),
  metadata: {
    storage: {
      format: "chunks-v1",
      indexSizeBytes: 500,
      indexSha256: "d".repeat(64),
      uploadedBytes: 600,
      chunks,
    } satisfies IncrementalBackupStorage,
  },
});

describe("backup storage metadata", () => {
  it("preserves legacy full artifacts without storage metadata", () => {
    const full = { key: "old/data.tar.zst", sizeBytes: 1234 };
    expect(incrementalBackupStorage(full)).toBeNull();
    expect([...backupArtifactObjects(full)]).toEqual([[full.key, 1234]]);
  });

  it("retains ordered repetitions while accounting for each physical block once", () => {
    const recorded = artifact([block(), block()]);
    expect(incrementalBackupStorage(recorded)?.chunks).toHaveLength(2);
    expect([...backupArtifactObjects(recorded)]).toEqual([
      [recorded.key, 500],
      [block().key, 100],
    ]);
  });

  it.each([
    ["sizeBytes", 200],
    ["sha256", "e".repeat(64)],
    ["contentBytes", 999],
    ["contentSha256", "f".repeat(64)],
  ] as const)("rejects contradictory %s for the same physical block", (field, value) => {
    expect(() =>
      incrementalBackupStorage(artifact([block(), { ...block(), [field]: value }])),
    ).toThrow(/Conflicting/);
  });

  it.each(["../outside", "/absolute", "a/../b", "a/./b", "a//b", "a\\b"])(
    "rejects unsafe block key %s",
    (key) => {
      expect(() => incrementalBackupStorage(artifact([{ ...block(), key }]))).toThrow(
        /Invalid.*block/,
      );
    },
  );

  it("refuses a block that aliases the snapshot index", () => {
    const recorded = artifact();
    const storage = recorded.metadata!.storage as IncrementalBackupStorage;
    storage.chunks[0].key = recorded.key;
    expect(() => backupArtifactObjects(recorded)).toThrow(/Invalid.*block/);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, BACKUP_CHUNK_BYTES + 1])(
    "bounds decoded block size (%s)",
    (contentBytes) => {
      expect(() => incrementalBackupStorage(artifact([{ ...block(), contentBytes }]))).toThrow(
        /Invalid/,
      );
    },
  );

  it("bounds the index and block count and checks reconstructed size", () => {
    const recorded = artifact();
    const storage = recorded.metadata!.storage as IncrementalBackupStorage;
    storage.indexSizeBytes = MAX_BACKUP_INDEX_BYTES + 1;
    expect(() => incrementalBackupStorage(recorded)).toThrow(/Invalid/);
    storage.indexSizeBytes = 500;
    storage.chunks = Array(MAX_BACKUP_CHUNKS + 1).fill(block());
    expect(() => incrementalBackupStorage(recorded)).toThrow(/Invalid/);
    storage.chunks = [block()];
    recorded.sizeBytes += 1;
    expect(() => incrementalBackupStorage(recorded)).toThrow(/size mismatch/);
  });

  it("refuses unknown encodings and malformed digests instead of treating them as full backups", () => {
    const recorded = artifact();
    expect(() =>
      incrementalBackupStorage({ ...recorded, metadata: { storage: { format: "future" } } }),
    ).toThrow(/Invalid/);
    expect(() => incrementalBackupStorage({ ...recorded, sha256: "invalid" })).toThrow(/Invalid/);
  });
});

describe("backup option validation", () => {
  it.each(["incremental", "quiesce", "clearPath", "verifyOnPrepare"])(
    "requires an actual boolean for %s",
    (key) => {
      expect(validatePolicyPayload("volume", { [key]: "false" })).toContain("true or false");
      expect(validatePolicyPayload("volume", { [key]: false })).toBeNull();
      expect(validatePolicyPayload("volume", { [key]: true })).toBeNull();
    },
  );

  it.each(["sourceIds", "exclude"])("rejects malformed %s selections", (key) => {
    expect(validatePolicyPayload("volume", { [key]: ["data", " "] })).toContain(
      "non-empty strings",
    );
    expect(validatePolicyPayload("volume", { [key]: "data" })).toContain("non-empty strings");
    expect(validatePolicyPayload("volume", { [key]: ["data"] })).toBeNull();
  });
});
