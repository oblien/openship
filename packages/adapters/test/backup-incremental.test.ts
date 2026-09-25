import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { BACKUP_CHUNK_BYTES, backupArtifactObjects, incrementalBackupStorage } from "@repo/core";
import {
  resolveDestination,
  uploadIncrementalArtifact,
  headBackupArtifact,
  openBackupArtifact,
  type BackupDestination,
  type BackupDestinationRow,
  type RecordedBackupArtifact,
} from "../src/backup";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openship-incremental-"));
  roots.push(root);
  const destination = resolveDestination({
    id: "test",
    organizationId: "test",
    name: "Test",
    kind: "local",
    endpoint: root,
  } as BackupDestinationRow);
  let sequence = 0;
  async function capture(body: Buffer, previous: RecordedBackupArtifact[] = []) {
    const uploaded: string[] = [];
    const recorded = await uploadIncrementalArtifact(
      destination,
      { projectSlug: "app", serviceName: "data", runId: `run-${sequence++}` },
      {
        name: "data.tar",
        stream: Readable.from([body]),
        metadata: { compression: "none" },
        payloadKind: "volume",
      },
      previous,
      uploaded,
    );
    return { recorded, uploaded };
  }
  return { destination, capture };
}
async function read(destination: BackupDestination, artifact: RecordedBackupArtifact) {
  const buffers: Buffer[] = [];
  for await (const chunk of await openBackupArtifact(destination, artifact))
    buffers.push(Buffer.from(chunk));
  return Buffer.concat(buffers);
}

describe("independently restorable incremental snapshots", () => {
  it("restores metadata after the database reorders JSON object keys", async () => {
    const { destination, capture } = await fixture();
    const body = Buffer.from("unchanged production data");
    const { recorded } = await capture(body);
    const storage = incrementalBackupStorage(recorded)!;
    storage.chunks = storage.chunks.map((chunk) =>
      Object.fromEntries(Object.entries(chunk).reverse()),
    ) as typeof storage.chunks;
    expect((await read(destination, recorded)).equals(body)).toBe(true);
    const next = await capture(body, [recorded]);
    expect(next.uploaded).toHaveLength(1);
    expect((await read(destination, next.recorded)).equals(body)).toBe(true);
  });

  it("uploads only changed blocks and restores after the previous index is deleted", async () => {
    const { destination, capture } = await fixture();
    const stable = randomBytes(BACKUP_CHUNK_BYTES * 2);
    const first = await capture(Buffer.concat([stable, Buffer.from("old tail")]));
    const expected = Buffer.concat([stable, Buffer.from("new tail and additions")]);
    const second = await capture(expected, [first.recorded]);
    const before = incrementalBackupStorage(first.recorded)!;
    const after = incrementalBackupStorage(second.recorded)!;
    expect(after.chunks.slice(0, 2)).toEqual(before.chunks.slice(0, 2));
    expect(after.uploadedBytes).toBeLessThan(before.uploadedBytes / 100);
    expect(second.uploaded).toHaveLength(2); // changed tail + this snapshot's index
    await destination.delete(first.recorded.key);
    await destination.delete(before.chunks[2].key);
    expect((await headBackupArtifact(destination, second.recorded))?.sizeBytes).toBe(
      expected.length,
    );
    expect((await read(destination, second.recorded)).equals(expected)).toBe(true);
    expect(second.recorded.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
  });

  it("does not reuse a corrupt block just because its size matches", async () => {
    const { destination, capture } = await fixture();
    const original = randomBytes(64 * 1024);
    const first = await capture(original);
    const block = incrementalBackupStorage(first.recorded)!.chunks[0];
    await destination.put(block.key, Readable.from([Buffer.alloc(block.sizeBytes, 42)]), {});
    await expect(read(destination, first.recorded)).rejects.toThrow(/integrity/);
    const repaired = await capture(original, [first.recorded]);
    expect(incrementalBackupStorage(repaired.recorded)!.chunks[0].key).not.toBe(block.key);
    expect((await read(destination, repaired.recorded)).equals(original)).toBe(true);
  });

  it.each(["missing", "truncated", "invalid gzip"])(
    "recaptures an old block whose read is %s",
    async (damage) => {
      const { destination, capture } = await fixture();
      const original = Buffer.from("the current source remains intact");
      const first = await capture(original);
      const block = incrementalBackupStorage(first.recorded)!.chunks[0];
      if (damage === "invalid gzip") {
        const corrupt = Buffer.alloc(block.sizeBytes, 42);
        // Even a matching stored-object digest cannot substitute for verifying
        // that the block reconstructs the source bytes it claims to contain.
        block.sha256 = createHash("sha256").update(corrupt).digest("hex");
        await destination.put(block.key, Readable.from([corrupt]), {});
      } else {
        vi.spyOn(destination, "get").mockImplementationOnce(async () => {
          if (damage === "missing") throw new Error("Object disappeared after HEAD");
          return Readable.from([Buffer.alloc(block.sizeBytes - 1)]);
        });
      }
      const repaired = await capture(original, [first.recorded]);
      expect(incrementalBackupStorage(repaired.recorded)!.chunks[0].key).not.toBe(block.key);
      expect((await read(destination, repaired.recorded)).equals(original)).toBe(true);
      expect(await destination.head(block.key)).not.toBeNull();
    },
  );

  it("deduplicates repeated blocks within a snapshot and counts physical storage once", async () => {
    const { destination, capture } = await fixture();
    const block = Buffer.alloc(BACKUP_CHUNK_BYTES, 42);
    const { recorded, uploaded } = await capture(Buffer.concat([block, block, block]));
    expect(uploaded).toHaveLength(2); // one gzip object + index
    expect(backupArtifactObjects(recorded).size).toBe(2);
    expect((await read(destination, recorded)).length).toBe(BACKUP_CHUNK_BYTES * 3);
  });

  it("rejects missing blocks, damaged indexes, and unknown formats before restoring", async () => {
    const { destination, capture } = await fixture();
    const { recorded } = await capture(Buffer.from("production data"));
    const block = incrementalBackupStorage(recorded)!.chunks[0];
    await destination.delete(block.key);
    await expect(headBackupArtifact(destination, recorded)).rejects.toThrow(/missing/);
    await destination.put(recorded.key, Readable.from([Buffer.from("damaged")]), {});
    await expect(openBackupArtifact(destination, recorded)).rejects.toThrow(/size/);
    await expect(
      openBackupArtifact(destination, { ...recorded, metadata: { storage: { format: "future" } } }),
    ).rejects.toThrow(/metadata/);
  });

  it("closes the source when storage rejects an upload", async () => {
    const { destination } = await fixture();
    const source = Readable.from(
      (async function* () {
        for (let i = 0; i < 10; i++) yield Buffer.alloc(BACKUP_CHUNK_BYTES, i);
      })(),
    );
    const failed = Object.assign(Object.create(destination), {
      put: async () => {
        throw new Error("storage unavailable");
      },
    });
    const keys: string[] = [];
    await expect(
      uploadIncrementalArtifact(
        failed,
        { projectSlug: "app", serviceName: "data", runId: "failed" },
        { name: "data.tar", stream: source, metadata: {}, payloadKind: "volume" },
        [],
        keys,
      ),
    ).rejects.toThrow("storage unavailable");
    expect(source.destroyed).toBe(true);
    expect(keys).toHaveLength(1); // The failed put remains named for cleanup.
  });
});
