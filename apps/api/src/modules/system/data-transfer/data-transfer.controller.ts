/**
 * HTTP surface for whole-instance data export / import (self-hosted only).
 *
 *   POST /api/system/data-transfer/export  — { passphrase? } → DataTransferFile
 *   POST /api/system/data-transfer/import   — { file, passphrase?, mode } → ImportResult
 *
 * AUTHORIZATION: instance administrator, enforced both by
 * `requireInstanceAdmin()` on the routes and by `assertInstanceAdmin(ctx)` here.
 * Export returns EVERY org's data with all secrets decrypted, sealed under a
 * passphrase the caller supplies — so it is a whole-instance read and an
 * org-scoped role check cannot gate it. It previously used
 * requireRole("owner"), which any authenticated user satisfied as owner of
 * their own personal org (GHSA-rwq6-r63g-3c8h).
 */

import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import { PkCollisionError } from "@repo/db";

import { audit, auditContextFrom } from "../../../lib/audit";
import { getRequestContext } from "../../../lib/request-context";
import { streamSSE } from "../../../lib/sse";
import { assertInstanceAdmin } from "../../../middleware/instance-admin";
import {
  MigrationAlreadyInProgressError,
  MigrationLockAcquireError,
} from "../migration/migration-lock";
import { exportInstance, previewInstanceExport } from "./export.service";
import { CloudInstanceNotTransferableError } from "./errors";
import { importInstance, InvalidTransferFileError } from "./import.service";
import { WrongPassphraseError } from "./passphrase-crypto";
import { InvalidExportSelectionError } from "./selection";
import {
  createDirectReceiveSession,
  DirectTransferDestinationError,
  DirectTransferSessionError,
  finalizeDirectChunkUpload,
  heartbeatDirectChunkUpload,
  initializeDirectChunkUpload,
  InvalidDirectTransferCodeError,
  receiveDirectChunk,
  receiveDirectTransfer,
  sendDirectTransfer,
} from "./direct-transfer.service";
import { createFileUpload, finalizeFileUpload, uploadFileChunk } from "./file-upload.service";
import { TransferStoreError } from "./chunk-store";
import type {
  DataTransferFile,
  DirectTransferEnvelope,
  DirectTransferResult,
  ExportSelection,
  ImportMode,
  ImportResult,
} from "./types";

interface ExportBody {
  passphrase?: string;
  selection?: ExportSelection;
}
interface ImportBody {
  file?: DataTransferFile;
  passphrase?: string;
  mode?: ImportMode;
}
interface CreateReceiveBody {
  apiBase?: string;
  mode?: ImportMode;
}
interface SendDirectBody {
  code?: string;
  selection?: ExportSelection;
}
interface FileUploadSessionBody {
  size?: number;
}

function readPassphrase(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

async function readJsonBody<T>(c: Context): Promise<T | null> {
  return c.req.json<T>().catch(() => null);
}

async function readFileFinalizeInput(c: Context): Promise<{
  passphrase?: string;
  mode: ImportMode;
} | null> {
  const body = await readJsonBody<{ passphrase?: unknown; mode?: unknown }>(c);
  if (!body || (body.mode !== "wipe" && body.mode !== "merge")) return null;
  return { passphrase: readPassphrase(body.passphrase), mode: body.mode };
}

export async function exportInstanceHandler(c: Context) {
  const ctx = getRequestContext(c);
  await assertInstanceAdmin(ctx);

  const body = ((await c.req.json<ExportBody>().catch(() => ({}))) ?? {}) as ExportBody;

  let file: DataTransferFile;
  try {
    file = await exportInstance({
      passphrase: readPassphrase(body.passphrase),
      selection: body.selection,
    });
  } catch (err) {
    if (err instanceof CloudInstanceNotTransferableError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    if (err instanceof InvalidExportSelectionError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    throw err;
  }

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "instance.data.exported",
    resourceType: "instance",
    after: {
      hasSecrets: !!file.secrets,
      tableCount: Object.keys(file.dump.tables).length,
      rowCount: file.summary?.rows,
      history: file.selection?.history,
    },
  });

  return c.json(file);
}

export async function previewInstanceExportHandler(c: Context) {
  const ctx = getRequestContext(c);
  await assertInstanceAdmin(ctx);
  try {
    return c.json(await previewInstanceExport());
  } catch (err) {
    if (err instanceof CloudInstanceNotTransferableError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    throw err;
  }
}

export async function createDirectReceiveSessionHandler(c: Context) {
  const ctx = getRequestContext(c);
  await assertInstanceAdmin(ctx);
  const body = ((await c.req.json<CreateReceiveBody>().catch(() => ({}))) ??
    {}) as CreateReceiveBody;
  if (typeof body.apiBase !== "string") {
    return c.json(
      { error: "Missing destination API URL.", code: "INVALID_DIRECT_TRANSFER_CODE" },
      400,
    );
  }
  try {
    const session = await createDirectReceiveSession({
      apiBase: body.apiBase,
      mode: body.mode === "merge" ? "merge" : "wipe",
    });
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: "instance.data.receive_code_created",
      resourceType: "instance",
      after: { mode: session.mode, expiresAt: session.expiresAt },
    });
    return c.json(session);
  } catch (err) {
    const response = transferProtocolError(c, err);
    if (response) return response;
    throw err;
  }
}

type TransferFailureStatus = 400 | 403 | 409 | 410 | 413 | 500 | 502 | 503;
interface TransferFailure {
  status: TransferFailureStatus;
  error: string;
  code: string;
}

function transferProtocolFailure(err: unknown): TransferFailure | null {
  if (err instanceof InvalidDirectTransferCodeError) {
    return { status: 400, error: err.message, code: err.code };
  }
  if (err instanceof DirectTransferSessionError) {
    return { status: 410, error: err.message, code: err.code };
  }
  if (err instanceof TransferStoreError) {
    const status =
      err.code === "PAYLOAD_TOO_LARGE"
        ? 413
        : err.code === "SESSION_BUSY"
          ? 409
          : err.code === "SESSION_UNAVAILABLE"
            ? 410
            : 400;
    return { status, error: err.message, code: err.code };
  }
  return null;
}

function transferProtocolError(c: Context, err: unknown): Response | null {
  const failure = transferProtocolFailure(err);
  return failure ? c.json({ error: failure.error, code: failure.code }, failure.status) : null;
}

/** Shared mapping for every import transport (legacy JSON, chunked file, and
 * direct transfer) so equivalent failures cannot drift by endpoint. */
function importOperationFailure(err: unknown): TransferFailure | null {
  const protocol = transferProtocolFailure(err);
  if (protocol) return protocol;
  if (err instanceof CloudInstanceNotTransferableError) {
    return { status: 403, error: err.message, code: err.code };
  }
  if (err instanceof InvalidTransferFileError || err instanceof WrongPassphraseError) {
    return { status: 400, error: err.message, code: err.code };
  }
  if (err instanceof PkCollisionError) {
    return {
      status: 409,
      error:
        "Some imported rows already exist on this instance. Use Replace mode, or remove the conflicting data first.",
      code: "PK_COLLISION",
    };
  }
  if (err instanceof MigrationAlreadyInProgressError || err instanceof MigrationLockAcquireError) {
    return {
      status: 503,
      error: "The destination is busy with another migration or import. Try again shortly.",
      code: "BUSY",
    };
  }
  return null;
}

function importOperationError(c: Context, err: unknown): Response | null {
  const failure = importOperationFailure(err);
  return failure ? c.json({ error: failure.error, code: failure.code }, failure.status) : null;
}

function destinationFailureStatus(status: number | undefined): TransferFailureStatus {
  if (
    status === 400 ||
    status === 403 ||
    status === 409 ||
    status === 410 ||
    status === 413 ||
    status === 500 ||
    status === 503
  )
    return status;
  if (status === 429) return 503;
  return status === undefined || status >= 500 ? 502 : 400;
}

function sendOperationFailure(err: unknown): TransferFailure | null {
  if (err instanceof InvalidDirectTransferCodeError) {
    return { status: 400, error: err.message, code: err.code };
  }
  if (err instanceof DirectTransferSessionError) {
    return { status: 410, error: err.message, code: err.code };
  }
  if (err instanceof DirectTransferDestinationError) {
    return {
      status: destinationFailureStatus(err.status),
      error: err.message,
      code: err.code,
    };
  }
  if (err instanceof CloudInstanceNotTransferableError) {
    return { status: 403, error: err.message, code: err.code };
  }
  if (err instanceof InvalidExportSelectionError) {
    return { status: 400, error: err.message, code: err.code };
  }
  return null;
}

async function writeTransferStreamResult<T>(
  stream: SSEStreamingApi,
  operation: () => Promise<T>,
  classify: (error: unknown) => TransferFailure | null,
): Promise<T | null> {
  try {
    const result = await operation();
    await stream.writeSSE({ event: "complete", data: JSON.stringify(result) });
    return result;
  } catch (error) {
    const classified = classify(error);
    const failure = classified ?? {
      status: 500 as const,
      error: "The data transfer failed unexpectedly.",
      code: "DATA_TRANSFER_FAILED",
    };
    if (!classified) console.error("[data-transfer] streamed operation failed:", error);
    await stream.writeSSE({ event: "error", data: JSON.stringify(failure) });
    return null;
  }
}

async function sendDirectAndAudit(
  c: Context,
  context: ReturnType<typeof getRequestContext>,
  body: Required<Pick<SendDirectBody, "code">> & Pick<SendDirectBody, "selection">,
): Promise<DirectTransferResult> {
  const result = await sendDirectTransfer({ code: body.code, selection: body.selection });
  audit.recordAsync(auditContextFrom(c, context.organizationId, context.userId), {
    eventType: "instance.data.sent",
    resourceType: "instance",
    after: {
      destination: result.destination,
      rowsRestored: result.rowsRestored,
      secretsRehydrated: result.secretsRehydrated,
    },
  });
  return result;
}

async function finalizeFileAndAudit(
  c: Context,
  context: ReturnType<typeof getRequestContext>,
  input: { uploadId: string; passphrase?: string; mode: ImportMode },
): Promise<ImportResult> {
  const result = await finalizeFileUpload({
    uploadId: input.uploadId,
    ownerUserId: context.userId,
    passphrase: input.passphrase,
    mode: input.mode,
  });
  audit.recordAsync(auditContextFrom(c, context.organizationId, context.userId), {
    eventType: "instance.data.imported",
    resourceType: "instance",
    after: {
      mode: result.mode,
      rowsRestored: result.rowsRestored,
      secretsRehydrated: result.secretsRehydrated,
    },
  });
  return result;
}

export async function initializeDirectChunkUploadHandler(c: Context) {
  const body = await readJsonBody<Parameters<typeof initializeDirectChunkUpload>[0]>(c);
  if (!body) {
    return c.json(
      { error: "Invalid transfer handshake.", code: "INVALID_DIRECT_TRANSFER_CODE" },
      400,
    );
  }
  try {
    return c.json(await initializeDirectChunkUpload(body));
  } catch (err) {
    const response = transferProtocolError(c, err);
    if (response) return response;
    throw err;
  }
}

export async function heartbeatDirectChunkUploadHandler(c: Context) {
  const body = await readJsonBody<{ signature?: string }>(c);
  if (!body) {
    return c.json(
      { error: "Invalid transfer heartbeat.", code: "INVALID_DIRECT_TRANSFER_CODE" },
      400,
    );
  }
  try {
    const sessionId = c.req.param("sessionId");
    if (!sessionId || typeof body.signature !== "string") {
      return c.json(
        { error: "Missing transfer signature.", code: "INVALID_DIRECT_TRANSFER_CODE" },
        400,
      );
    }
    return c.json(await heartbeatDirectChunkUpload(sessionId, body.signature));
  } catch (err) {
    const response = transferProtocolError(c, err);
    if (response) return response;
    throw err;
  }
}

export async function receiveDirectChunkHandler(c: Context) {
  try {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) {
      return c.json(
        { error: "Missing transfer session.", code: "INVALID_DIRECT_TRANSFER_CODE" },
        400,
      );
    }
    const index = Number(c.req.param("index"));
    const sha256 = c.req.header("x-openship-chunk-sha256") ?? "";
    const signature = c.req.header("x-openship-transfer-signature") ?? "";
    await receiveDirectChunk({
      sessionId,
      index,
      sha256,
      signature,
      readBytes: async () => new Uint8Array(await c.req.arrayBuffer()),
    });
    return c.json({ ok: true });
  } catch (err) {
    const response = transferProtocolError(c, err);
    if (response) return response;
    throw err;
  }
}

/** Heartbeat stream for a potentially long atomic restore. */
export async function finalizeDirectChunkUploadStreamHandler(c: Context) {
  const sessionId = c.req.param("sessionId");
  if (!sessionId) {
    return c.json(
      { error: "Missing transfer session.", code: "INVALID_DIRECT_TRANSFER_CODE" },
      400,
    );
  }
  const body = await readJsonBody<Parameters<typeof finalizeDirectChunkUpload>[1]>(c);
  if (!body) {
    return c.json(
      { error: "Invalid transfer manifest.", code: "INVALID_DIRECT_TRANSFER_CODE" },
      400,
    );
  }
  return streamSSE(c, async (stream) => {
    await writeTransferStreamResult(
      stream,
      () => finalizeDirectChunkUpload(sessionId, body),
      importOperationFailure,
    );
  });
}

export async function sendDirectTransferHandler(c: Context) {
  const ctx = getRequestContext(c);
  await assertInstanceAdmin(ctx);
  const body = ((await c.req.json<SendDirectBody>().catch(() => ({}))) ?? {}) as SendDirectBody;
  if (typeof body.code !== "string") {
    return c.json({ error: "Missing receive code.", code: "INVALID_DIRECT_TRANSFER_CODE" }, 400);
  }
  try {
    return c.json(await sendDirectAndAudit(c, ctx, { code: body.code, selection: body.selection }));
  } catch (err) {
    const failure = sendOperationFailure(err);
    if (failure) return c.json({ error: failure.error, code: failure.code }, failure.status);
    throw err;
  }
}

/** Streamed form used by the dashboard so export/upload/import cannot be cut off
 * by a reverse proxy's idle response timeout. */
export async function sendDirectTransferStreamHandler(c: Context) {
  const ctx = getRequestContext(c);
  await assertInstanceAdmin(ctx);
  const body = ((await c.req.json<SendDirectBody>().catch(() => ({}))) ?? {}) as SendDirectBody;
  if (typeof body.code !== "string") {
    return c.json({ error: "Missing receive code.", code: "INVALID_DIRECT_TRANSFER_CODE" }, 400);
  }
  return streamSSE(c, async (stream) => {
    await writeTransferStreamResult(
      stream,
      () => sendDirectAndAudit(c, ctx, { code: body.code!, selection: body.selection }),
      sendOperationFailure,
    );
  });
}

/** Public capability endpoint: the encrypted receive code is the authorization. */
export async function receiveDirectTransferHandler(c: Context) {
  let envelope: DirectTransferEnvelope;
  try {
    envelope = await c.req.json<DirectTransferEnvelope>();
  } catch {
    return c.json(
      { error: "Invalid encrypted transfer body.", code: "INVALID_DIRECT_TRANSFER_CODE" },
      400,
    );
  }
  try {
    return c.json(await receiveDirectTransfer(envelope));
  } catch (err) {
    const response = importOperationError(c, err);
    if (response) return response;
    throw err;
  }
}

export async function importInstanceHandler(c: Context) {
  const ctx = getRequestContext(c);
  await assertInstanceAdmin(ctx);

  let body: ImportBody;
  try {
    body = await c.req.json<ImportBody>();
  } catch {
    return c.json({ error: "Invalid JSON body.", code: "INVALID_JSON" }, 400);
  }
  if (!body.file) {
    return c.json({ error: "Missing export file.", code: "INVALID_TRANSFER_FILE" }, 400);
  }
  const mode: ImportMode = body.mode === "merge" ? "merge" : "wipe";

  try {
    const result = await importInstance({
      file: body.file,
      passphrase: readPassphrase(body.passphrase),
      mode,
    });

    // Best-effort audit; on a wipe import the pre-import identity may be gone,
    // so this write can no-op (audit.record swallows its own errors).
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: "instance.data.imported",
      resourceType: "instance",
      after: {
        mode: result.mode,
        rowsRestored: result.rowsRestored,
        secretsRehydrated: result.secretsRehydrated,
      },
    });

    return c.json(result);
  } catch (err) {
    const response = importOperationError(c, err);
    if (response) return response;
    throw err;
  }
}

/** Open an authenticated chunk upload; the browser never reads the whole file. */
export async function createFileUploadHandler(c: Context) {
  const ctx = getRequestContext(c);
  await assertInstanceAdmin(ctx);
  const body = await readJsonBody<FileUploadSessionBody>(c);
  if (!body) {
    return c.json({ error: "Invalid upload session request.", code: "INVALID_CHUNK" }, 400);
  }
  try {
    if (!Number.isSafeInteger(body.size) || (body.size ?? 0) <= 0) {
      return c.json(
        { error: "A positive export file size is required.", code: "INVALID_CHUNK" },
        400,
      );
    }
    return c.json(await createFileUpload({ ownerUserId: ctx.userId, size: body.size! }));
  } catch (err) {
    const response = transferProtocolError(c, err);
    if (response) return response;
    throw err;
  }
}

export async function uploadFileChunkHandler(c: Context) {
  const ctx = getRequestContext(c);
  await assertInstanceAdmin(ctx);
  try {
    const uploadId = c.req.param("sessionId");
    if (!uploadId) {
      return c.json({ error: "Missing import upload session.", code: "SESSION_UNAVAILABLE" }, 400);
    }
    await uploadFileChunk({
      uploadId,
      ownerUserId: ctx.userId,
      index: Number(c.req.param("index")),
      sha256: c.req.header("x-openship-chunk-sha256") ?? "",
      readBytes: async () => new Uint8Array(await c.req.arrayBuffer()),
    });
    return c.json({ ok: true });
  } catch (err) {
    const response = transferProtocolError(c, err);
    if (response) return response;
    throw err;
  }
}

/** Streamed file finalization; upload requests stay bounded and the subsequent
 * atomic restore receives heartbeat bytes until its terminal result. */
export async function finalizeFileUploadStreamHandler(c: Context) {
  const ctx = getRequestContext(c);
  await assertInstanceAdmin(ctx);
  const uploadId = c.req.param("sessionId");
  if (!uploadId) {
    return c.json({ error: "Missing import upload session.", code: "SESSION_UNAVAILABLE" }, 400);
  }
  const body = await readFileFinalizeInput(c);
  if (!body) {
    return c.json(
      { error: "Import mode must be wipe or merge.", code: "INVALID_IMPORT_MODE" },
      400,
    );
  }
  const input = {
    uploadId,
    passphrase: body.passphrase,
    mode: body.mode,
  };
  return streamSSE(c, async (stream) => {
    await writeTransferStreamResult(
      stream,
      () => finalizeFileAndAudit(c, ctx, input),
      importOperationFailure,
    );
  });
}
