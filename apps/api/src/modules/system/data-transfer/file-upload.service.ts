import {
  assertCompleteChunkSet,
  claimSession,
  completeSessionInTransaction,
  createFileSession,
  getSession,
  listChunkMetadata,
  releaseSessionClaim,
  stageChunk,
  TRANSFER_CHUNK_BYTES,
  TransferStoreError,
  withSessionClaimLease,
} from "./chunk-store";
import { importInstance } from "./import.service";
import { readStagedJson } from "./staged-payload";
import type { DataTransferFile, ImportMode, ImportResult } from "./types";

export async function createFileUpload(input: { ownerUserId: string; size: number }) {
  const session = await createFileSession({
    ownerUserId: input.ownerUserId,
    expectedBytes: input.size,
  });
  return {
    uploadId: session.id,
    chunkSize: TRANSFER_CHUNK_BYTES,
    totalChunks: session.expectedChunks!,
    expiresAt: session.expiresAt.toISOString(),
  };
}

function ownedFileSession(session: Awaited<ReturnType<typeof getSession>>, ownerUserId: string) {
  if (!session || session.kind !== "file" || session.ownerUserId !== ownerUserId) {
    throw new TransferStoreError(
      "The import upload session is unavailable.",
      "SESSION_UNAVAILABLE",
    );
  }
  return session;
}

export async function uploadFileChunk(input: {
  uploadId: string;
  ownerUserId: string;
  index: number;
  sha256: string;
  readBytes: () => Promise<Uint8Array>;
}): Promise<void> {
  const session = ownedFileSession(await getSession(input.uploadId), input.ownerUserId);
  if (session.status !== "uploading") {
    throw new TransferStoreError("The import upload is no longer writable.", "SESSION_UNAVAILABLE");
  }
  if (
    !Number.isSafeInteger(input.index) ||
    input.index < 0 ||
    !/^[a-f0-9]{64}$/.test(input.sha256)
  ) {
    throw new TransferStoreError("The import chunk metadata is invalid.", "INVALID_CHUNK");
  }
  const expectedChunks = session.expectedChunks ?? 0;
  const expectedBytes = session.expectedBytes ?? 0;
  if (input.index >= expectedChunks) {
    throw new TransferStoreError("The import chunk index is out of range.", "INVALID_CHUNK");
  }
  // Authenticate the owner/session and validate the index before buffering the
  // request body. The body limit remains a second, transport-level boundary.
  const bytes = await input.readBytes();
  const expectedLength =
    input.index === expectedChunks - 1
      ? expectedBytes - TRANSFER_CHUNK_BYTES * input.index
      : TRANSFER_CHUNK_BYTES;
  if (bytes.byteLength !== expectedLength) {
    throw new TransferStoreError(
      `Import chunk ${input.index} has ${bytes.byteLength} bytes; expected ${expectedLength}.`,
      "INVALID_CHUNK",
    );
  }
  await stageChunk({ session, index: input.index, bytes, sha256: input.sha256 });
}

export async function finalizeFileUpload(input: {
  uploadId: string;
  ownerUserId: string;
  passphrase?: string;
  mode: ImportMode;
}): Promise<ImportResult> {
  const current = ownedFileSession(await getSession(input.uploadId), input.ownerUserId);
  if (current.status === "complete" && current.result) {
    return current.result as unknown as ImportResult;
  }
  if (current.status !== "uploading") {
    throw new TransferStoreError(
      "The import upload is already being finalized.",
      "SESSION_UNAVAILABLE",
    );
  }

  // Validate before claiming so a premature finalize remains resumable: the
  // browser can upload the missing chunk and call finalize again.
  assertCompleteChunkSet(await listChunkMetadata(current.id), current.expectedChunks ?? 0);
  const session = await claimSession(current);
  try {
    return await withSessionClaimLease(session, async () => {
      const file = (await readStagedJson(
        session,
        {
          totalChunks: session.expectedChunks ?? 0,
          totalBytes: session.expectedBytes ?? 0,
        },
        (bytes) => bytes,
      )) as DataTransferFile;
      return importInstance({
        file,
        passphrase: input.passphrase,
        mode: input.mode,
        onBeforeCommit: (tx, imported) => completeSessionInTransaction(tx, session, imported),
      });
    });
  } catch (error) {
    // Authenticated file uploads are owner-bound rather than one-time public
    // capabilities. Preserve their verified chunks so a wrong passphrase,
    // merge collision, or transient migration lock can be corrected without
    // uploading hundreds of megabytes again.
    await releaseSessionClaim(session).catch(() => undefined);
    throw error;
  }
}
