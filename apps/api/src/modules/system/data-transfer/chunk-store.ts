/**
 * Durable, bounded staging for whole-instance transfers.
 *
 * Session metadata and chunks live in the database so a request may land on a
 * different API worker and a short process restart does not invalidate a receive
 * code. The tables are explicitly excluded from instance dumps, so a wipe import
 * cannot replace the upload that is currently feeding it.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  and,
  count,
  db,
  eq,
  gt,
  inArray,
  lte,
  ne,
  or,
  schema,
  type DatabaseTransaction,
} from "@repo/db";

import type { ImportMode, ImportResult } from "./types";

export const TRANSFER_CHUNK_BYTES = 8_000_000;
export const MAX_TRANSFER_BYTES = 500_000_000;
export const MAX_TRANSFER_CHUNKS = Math.ceil(MAX_TRANSFER_BYTES / TRANSFER_CHUNK_BYTES);
export const TRANSFER_CONTROL_BODY_BYTES = 32_000;

// A receive code is a powerful bearer capability, so leave it usable for only
// ten idle minutes. Active uploads refresh this lease on every chunk/heartbeat;
// the absolute cap below prevents an abandoned transfer from living forever.
const SESSION_IDLE_TTL_MS = 10 * 60_000;
const SESSION_MAX_TTL_MS = 6 * 60 * 60_000;
const COMPLETED_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_SESSIONS = 20;
const CLAIM_HEARTBEAT_MS = 60_000;

export type TransferSessionRow = typeof schema.dataTransferSession.$inferSelect;

export interface TransferChunkMeta {
  chunkIndex: number;
  byteLength: number;
  sha256: string;
}

export class TransferStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "SESSION_UNAVAILABLE"
      | "SESSION_BUSY"
      | "PAYLOAD_TOO_LARGE"
      | "INVALID_CHUNK"
      | "MISSING_CHUNK",
  ) {
    super(message);
    this.name = "TransferStoreError";
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function nextLease(row: Pick<TransferSessionRow, "maxExpiresAt">, now = Date.now()): Date {
  return new Date(Math.min(now + SESSION_IDLE_TTL_MS, row.maxExpiresAt.getTime()));
}

async function assertCapacity(now = new Date()): Promise<void> {
  // An idle upload may be deleted immediately. A finalizer gets a renewable
  // lease: retain its chunks until either another request recovers the stale
  // claim or the six-hour absolute cap passes.
  await db
    .delete(schema.dataTransferSession)
    .where(
      or(
        lte(schema.dataTransferSession.maxExpiresAt, now),
        and(
          ne(schema.dataTransferSession.status, "consuming"),
          lte(schema.dataTransferSession.expiresAt, now),
        ),
      ),
    );
  const [row] = await db
    .select({ value: count() })
    .from(schema.dataTransferSession)
    .where(
      and(
        gt(schema.dataTransferSession.expiresAt, now),
        inArray(schema.dataTransferSession.status, ["ready", "uploading", "consuming"]),
      ),
    );
  if (Number(row?.value ?? 0) >= MAX_ACTIVE_SESSIONS) {
    throw new TransferStoreError(
      "Too many active data transfers. Wait for an existing transfer to finish or expire.",
      "SESSION_BUSY",
    );
  }
}

function expiryWindow(now = Date.now()): { expiresAt: Date; maxExpiresAt: Date } {
  return {
    expiresAt: new Date(now + SESSION_IDLE_TTL_MS),
    maxExpiresAt: new Date(now + SESSION_MAX_TTL_MS),
  };
}

export async function createDirectSession(input: {
  mode: ImportMode;
  tokenHash: string;
  privateKey: string;
}): Promise<TransferSessionRow> {
  await assertCapacity();
  const now = Date.now();
  const [row] = await db
    .insert(schema.dataTransferSession)
    .values({
      id: randomUUID(),
      kind: "direct",
      status: "ready",
      mode: input.mode,
      tokenHash: input.tokenHash,
      privateKey: input.privateKey,
      ...expiryWindow(now),
      updatedAt: new Date(now),
    })
    .returning();
  return row as TransferSessionRow;
}

export async function createFileSession(input: {
  ownerUserId: string;
  expectedBytes: number;
}): Promise<TransferSessionRow> {
  if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes <= 0) {
    throw new TransferStoreError(
      "The selected export file is empty or has an invalid size.",
      "INVALID_CHUNK",
    );
  }
  if (input.expectedBytes > MAX_TRANSFER_BYTES) {
    throw new TransferStoreError(
      `Import file exceeds the ${Math.floor(MAX_TRANSFER_BYTES / 1_000_000)}MB limit.`,
      "PAYLOAD_TOO_LARGE",
    );
  }
  await assertCapacity();
  const now = Date.now();
  const [row] = await db
    .insert(schema.dataTransferSession)
    .values({
      id: randomUUID(),
      kind: "file",
      status: "uploading",
      ownerUserId: input.ownerUserId,
      expectedBytes: input.expectedBytes,
      expectedChunks: Math.ceil(input.expectedBytes / TRANSFER_CHUNK_BYTES),
      ...expiryWindow(now),
      updatedAt: new Date(now),
    })
    .returning();
  return row as TransferSessionRow;
}

export async function getSession(id: string): Promise<TransferSessionRow | null> {
  const [row] = await db
    .select()
    .from(schema.dataTransferSession)
    .where(
      and(
        eq(schema.dataTransferSession.id, id),
        gt(schema.dataTransferSession.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (row) return row as TransferSessionRow;

  // A worker may die after claiming a complete chunk set but before its restore
  // transaction commits. Once that worker stops renewing the claim, make the
  // same durable upload resumable instead of wedging it until the absolute cap.
  return db.transaction(async (tx) => {
    const now = new Date();
    const [stale] = await tx
      .select()
      .from(schema.dataTransferSession)
      .where(
        and(
          eq(schema.dataTransferSession.id, id),
          eq(schema.dataTransferSession.status, "consuming"),
          lte(schema.dataTransferSession.expiresAt, now),
          gt(schema.dataTransferSession.maxExpiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (!stale) return null;
    const [recovered] = await tx
      .update(schema.dataTransferSession)
      .set({
        status: "uploading",
        claimToken: null,
        expiresAt: nextLease(stale as TransferSessionRow, now.getTime()),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.dataTransferSession.id, id),
          eq(schema.dataTransferSession.status, "consuming"),
        ),
      )
      .returning();
    return (recovered as TransferSessionRow | undefined) ?? null;
  });
}

export async function beginDirectSession(
  id: string,
  senderPublicKey: string,
): Promise<TransferSessionRow | null> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [current] = await tx
      .select()
      .from(schema.dataTransferSession)
      .where(
        and(
          eq(schema.dataTransferSession.id, id),
          eq(schema.dataTransferSession.kind, "direct"),
          gt(schema.dataTransferSession.expiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (!current || (current.status !== "ready" && current.status !== "uploading")) return null;

    // A source process that restarts creates a fresh ephemeral X25519 key. The
    // encrypted token proof was already verified by the caller, so let that
    // holder restart cleanly and discard ciphertext tied to the previous key.
    if (current.status === "uploading" && current.senderPublicKey !== senderPublicKey) {
      await tx.delete(schema.dataTransferChunk).where(eq(schema.dataTransferChunk.sessionId, id));
    }

    const [row] = await tx
      .update(schema.dataTransferSession)
      .set({
        status: "uploading",
        senderPublicKey,
        expiresAt: nextLease(current as TransferSessionRow, now.getTime()),
        updatedAt: now,
      })
      .where(eq(schema.dataTransferSession.id, id))
      .returning();
    return (row as TransferSessionRow | undefined) ?? null;
  });
}

export async function touchSession(
  id: string,
  senderPublicKey: string,
): Promise<TransferSessionRow | null> {
  const current = await getSession(id);
  if (
    !current ||
    current.kind !== "direct" ||
    current.status !== "uploading" ||
    current.senderPublicKey !== senderPublicKey
  )
    return null;
  const now = new Date();
  const [row] = await db
    .update(schema.dataTransferSession)
    .set({ expiresAt: nextLease(current, now.getTime()), updatedAt: now })
    .where(
      and(
        eq(schema.dataTransferSession.id, id),
        eq(schema.dataTransferSession.kind, "direct"),
        eq(schema.dataTransferSession.status, "uploading"),
        eq(schema.dataTransferSession.senderPublicKey, senderPublicKey),
        gt(schema.dataTransferSession.expiresAt, now),
      ),
    )
    .returning();
  return (row as TransferSessionRow | undefined) ?? null;
}

export async function stageChunk(input: {
  session: TransferSessionRow;
  index: number;
  bytes: Uint8Array;
  sha256: string;
}): Promise<void> {
  if (
    input.session.status !== "uploading" ||
    !Number.isSafeInteger(input.index) ||
    input.index < 0 ||
    input.index >= MAX_TRANSFER_CHUNKS ||
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > TRANSFER_CHUNK_BYTES + 64
  ) {
    throw new TransferStoreError("The transfer chunk is invalid or out of range.", "INVALID_CHUNK");
  }
  const digest = sha256Hex(input.bytes);
  if (!/^[a-f0-9]{64}$/.test(input.sha256) || digest !== input.sha256) {
    throw new TransferStoreError(
      "The transfer chunk checksum does not match its contents.",
      "INVALID_CHUNK",
    );
  }

  await db.transaction(async (tx) => {
    // Lock/refresh the writable session in the same transaction as the INSERT.
    // A concurrent finalize changes status to `consuming`; exactly one side wins
    // the row update, so no chunk can appear after finalization has claimed the set.
    const now = new Date();
    const identity =
      input.session.kind === "direct"
        ? and(
            eq(schema.dataTransferSession.kind, "direct"),
            eq(schema.dataTransferSession.senderPublicKey, input.session.senderPublicKey!),
          )
        : and(
            eq(schema.dataTransferSession.kind, "file"),
            eq(schema.dataTransferSession.ownerUserId, input.session.ownerUserId!),
          );
    const writable = await tx
      .update(schema.dataTransferSession)
      .set({ expiresAt: nextLease(input.session, now.getTime()), updatedAt: now })
      .where(
        and(
          eq(schema.dataTransferSession.id, input.session.id),
          eq(schema.dataTransferSession.status, "uploading"),
          identity,
          gt(schema.dataTransferSession.expiresAt, now),
        ),
      )
      .returning();
    if (writable.length === 0) {
      throw new TransferStoreError(
        "The transfer session is no longer writable.",
        "SESSION_UNAVAILABLE",
      );
    }

    const inserted = await tx
      .insert(schema.dataTransferChunk)
      .values({
        sessionId: input.session.id,
        chunkIndex: input.index,
        bytes: input.bytes,
        byteLength: input.bytes.byteLength,
        sha256: digest,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) {
      const [existing] = await tx
        .select({
          sha256: schema.dataTransferChunk.sha256,
          byteLength: schema.dataTransferChunk.byteLength,
        })
        .from(schema.dataTransferChunk)
        .where(
          and(
            eq(schema.dataTransferChunk.sessionId, input.session.id),
            eq(schema.dataTransferChunk.chunkIndex, input.index),
          ),
        )
        .limit(1);
      if (existing?.sha256 !== digest || existing.byteLength !== input.bytes.byteLength) {
        throw new TransferStoreError(
          `Chunk ${input.index} was already uploaded with different contents.`,
          "INVALID_CHUNK",
        );
      }
    }
  });
}

export async function listChunkMetadata(sessionId: string): Promise<TransferChunkMeta[]> {
  return db
    .select({
      chunkIndex: schema.dataTransferChunk.chunkIndex,
      byteLength: schema.dataTransferChunk.byteLength,
      sha256: schema.dataTransferChunk.sha256,
    })
    .from(schema.dataTransferChunk)
    .where(eq(schema.dataTransferChunk.sessionId, sessionId))
    .orderBy(schema.dataTransferChunk.chunkIndex);
}

export async function readChunk(sessionId: string, index: number): Promise<Uint8Array | null> {
  const [row] = await db
    .select({ bytes: schema.dataTransferChunk.bytes })
    .from(schema.dataTransferChunk)
    .where(
      and(
        eq(schema.dataTransferChunk.sessionId, sessionId),
        eq(schema.dataTransferChunk.chunkIndex, index),
      ),
    )
    .limit(1);
  return row?.bytes ?? null;
}

export function assertCompleteChunkSet(
  chunks: readonly TransferChunkMeta[],
  expectedChunks: number,
): void {
  if (
    !Number.isSafeInteger(expectedChunks) ||
    expectedChunks <= 0 ||
    expectedChunks > MAX_TRANSFER_CHUNKS ||
    chunks.length !== expectedChunks ||
    chunks.some((chunk, index) => chunk.chunkIndex !== index)
  ) {
    throw new TransferStoreError("One or more transfer chunks are missing.", "MISSING_CHUNK");
  }
}

export async function claimSession(expected: TransferSessionRow): Promise<TransferSessionRow> {
  if (expected.status !== "uploading") {
    throw new TransferStoreError(
      "The transfer is already being finalized or is no longer available.",
      "SESSION_UNAVAILABLE",
    );
  }
  const now = new Date();
  const claimToken = randomUUID();
  const identity =
    expected.kind === "direct"
      ? and(
          eq(schema.dataTransferSession.kind, "direct"),
          eq(schema.dataTransferSession.senderPublicKey, expected.senderPublicKey!),
        )
      : and(
          eq(schema.dataTransferSession.kind, "file"),
          eq(schema.dataTransferSession.ownerUserId, expected.ownerUserId!),
        );
  const [row] = await db
    .update(schema.dataTransferSession)
    .set({
      status: "consuming",
      claimToken,
      expiresAt: nextLease(expected, now.getTime()),
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.dataTransferSession.id, expected.id),
        eq(schema.dataTransferSession.status, "uploading"),
        identity,
        gt(schema.dataTransferSession.expiresAt, now),
      ),
    )
    .returning();
  if (!row) {
    throw new TransferStoreError(
      "The transfer is already being finalized or is no longer available.",
      "SESSION_UNAVAILABLE",
    );
  }
  return row as TransferSessionRow;
}

async function renewSessionClaim(session: TransferSessionRow): Promise<void> {
  if (!session.claimToken) return;
  const now = new Date();
  await db
    .update(schema.dataTransferSession)
    .set({ expiresAt: nextLease(session, now.getTime()), updatedAt: now })
    .where(
      and(
        eq(schema.dataTransferSession.id, session.id),
        eq(schema.dataTransferSession.status, "consuming"),
        eq(schema.dataTransferSession.claimToken, session.claimToken),
        gt(schema.dataTransferSession.maxExpiresAt, now),
      ),
    );
}

/** Keep a finalizer's recoverable lease alive while it parses and restores. */
export async function withSessionClaimLease<T>(
  session: TransferSessionRow,
  operation: () => Promise<T>,
): Promise<T> {
  let renewalRunning = false;
  const heartbeat = setInterval(() => {
    if (renewalRunning) return;
    renewalRunning = true;
    void renewSessionClaim(session)
      .catch(() => undefined)
      .finally(() => {
        renewalRunning = false;
      });
  }, CLAIM_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
  }
}

export async function releaseSessionClaim(session: TransferSessionRow): Promise<void> {
  if (!session.claimToken) return;
  const now = new Date();
  await db
    .update(schema.dataTransferSession)
    .set({
      status: "uploading",
      claimToken: null,
      expiresAt: nextLease(session, now.getTime()),
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.dataTransferSession.id, session.id),
        eq(schema.dataTransferSession.status, "consuming"),
        eq(schema.dataTransferSession.claimToken, session.claimToken),
      ),
    );
}

export async function completeSessionInTransaction(
  tx: DatabaseTransaction,
  session: TransferSessionRow,
  result: ImportResult,
): Promise<void> {
  if (!session.claimToken) {
    throw new TransferStoreError("The transfer completion claim was lost.", "SESSION_UNAVAILABLE");
  }
  const now = new Date();
  const completed = await tx
    .update(schema.dataTransferSession)
    .set({
      status: "complete",
      claimToken: null,
      result: result as unknown as Record<string, unknown>,
      expiresAt: new Date(now.getTime() + COMPLETED_TTL_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.dataTransferSession.id, session.id),
        eq(schema.dataTransferSession.status, "consuming"),
        eq(schema.dataTransferSession.claimToken, session.claimToken),
      ),
    )
    .returning();
  if (completed.length !== 1) {
    throw new TransferStoreError("The transfer completion claim was lost.", "SESSION_UNAVAILABLE");
  }
  await tx
    .delete(schema.dataTransferChunk)
    .where(eq(schema.dataTransferChunk.sessionId, session.id));
}

export async function failSession(session: TransferSessionRow): Promise<void> {
  if (!session.claimToken) return;
  const claimToken = session.claimToken;
  const now = new Date();
  await db.transaction(async (tx) => {
    const failed = await tx
      .update(schema.dataTransferSession)
      .set({
        status: "failed",
        claimToken: null,
        expiresAt: new Date(now.getTime() + COMPLETED_TTL_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.dataTransferSession.id, session.id),
          eq(schema.dataTransferSession.status, "consuming"),
          eq(schema.dataTransferSession.claimToken, claimToken),
        ),
      )
      .returning();
    if (failed.length === 1) {
      await tx
        .delete(schema.dataTransferChunk)
        .where(eq(schema.dataTransferChunk.sessionId, session.id));
    }
  });
}

export async function clearTransferSessionsForTest(): Promise<void> {
  if (process.env.NODE_ENV === "test") await db.delete(schema.dataTransferSession);
}
