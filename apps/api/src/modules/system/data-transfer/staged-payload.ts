import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertCompleteChunkSet,
  listChunkMetadata,
  MAX_TRANSFER_BYTES,
  readChunk,
  type TransferSessionRow,
} from "./chunk-store";

export interface StagedPayloadManifest {
  totalChunks: number;
  totalBytes: number;
  sha256?: string;
}

/**
 * Reassemble a staged upload with constant chunk memory, validating its complete
 * ordered byte stream before JSON parsing. JSON.parse still needs one final
 * in-memory document because the existing atomic DB restore consumes a coherent
 * DatabaseDump; request/encryption/base64 copies no longer coexist with it.
 */
export async function readStagedJson(
  session: TransferSessionRow,
  manifest: StagedPayloadManifest,
  decode: (chunk: Uint8Array, index: number) => Uint8Array,
): Promise<unknown> {
  if (
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes <= 0 ||
    manifest.totalBytes > MAX_TRANSFER_BYTES ||
    (manifest.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(manifest.sha256))
  ) {
    throw new Error("The staged transfer manifest is invalid.");
  }

  const metadata = await listChunkMetadata(session.id);
  assertCompleteChunkSet(metadata, manifest.totalChunks);

  const dir = await mkdtemp(join(tmpdir(), "openship-transfer-"));
  const path = join(dir, "payload.json");
  const handle = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let bytesWritten = 0;

  try {
    for (let index = 0; index < manifest.totalChunks; index += 1) {
      const staged = await readChunk(session.id, index);
      if (!staged) throw new Error(`Transfer chunk ${index} disappeared during finalization.`);
      const plaintext = Buffer.from(decode(staged, index));
      bytesWritten += plaintext.byteLength;
      if (bytesWritten > MAX_TRANSFER_BYTES)
        throw new Error("The staged transfer exceeds the size limit.");
      hash.update(plaintext);
      let offset = 0;
      while (offset < plaintext.byteLength) {
        const written = await handle.write(plaintext, offset, plaintext.byteLength - offset);
        if (written.bytesWritten <= 0) {
          throw new Error("The staged transfer could not be written to temporary storage.");
        }
        offset += written.bytesWritten;
      }
    }
    await handle.sync();
    await handle.close();

    if (bytesWritten !== manifest.totalBytes) {
      throw new Error(
        `Transfer size mismatch: received ${bytesWritten} bytes, expected ${manifest.totalBytes}.`,
      );
    }
    if (manifest.sha256 && hash.digest("hex") !== manifest.sha256) {
      throw new Error("The complete transfer checksum does not match.");
    }

    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } finally {
    await handle.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}
