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
import { PkCollisionError } from "@repo/db";

import { audit, auditContextFrom } from "../../../lib/audit";
import { getRequestContext } from "../../../lib/request-context";
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
  InvalidDirectTransferCodeError,
  receiveDirectTransfer,
  sendDirectTransfer,
} from "./direct-transfer.service";
import type {
  DataTransferFile,
  DirectTransferEnvelope,
  ExportSelection,
  ImportMode,
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

function readPassphrase(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
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
  const body = ((await c.req.json<CreateReceiveBody>().catch(() => ({}))) ?? {}) as CreateReceiveBody;
  if (typeof body.apiBase !== "string") {
    return c.json({ error: "Missing destination API URL.", code: "INVALID_DIRECT_TRANSFER_CODE" }, 400);
  }
  try {
    const session = createDirectReceiveSession({
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
    if (err instanceof InvalidDirectTransferCodeError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    if (err instanceof DirectTransferSessionError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    throw err;
  }
}

export async function sendDirectTransferHandler(c: Context) {
  const ctx = getRequestContext(c);
  await assertInstanceAdmin(ctx);
  const body = ((await c.req.json<SendDirectBody>().catch(() => ({}))) ?? {}) as SendDirectBody;
  if (typeof body.code !== "string") {
    return c.json({ error: "Missing receive code.", code: "INVALID_DIRECT_TRANSFER_CODE" }, 400);
  }
  try {
    const result = await sendDirectTransfer({ code: body.code, selection: body.selection });
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: "instance.data.sent",
      resourceType: "instance",
      after: {
        destination: result.destination,
        rowsRestored: result.rowsRestored,
        secretsRehydrated: result.secretsRehydrated,
      },
    });
    return c.json(result);
  } catch (err) {
    if (
      err instanceof InvalidDirectTransferCodeError ||
      err instanceof DirectTransferSessionError ||
      err instanceof DirectTransferDestinationError
    ) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    if (err instanceof CloudInstanceNotTransferableError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    if (err instanceof InvalidExportSelectionError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    throw err;
  }
}

/** Public capability endpoint: the encrypted receive code is the authorization. */
export async function receiveDirectTransferHandler(c: Context) {
  let envelope: DirectTransferEnvelope;
  try {
    envelope = await c.req.json<DirectTransferEnvelope>();
  } catch {
    return c.json({ error: "Invalid encrypted transfer body.", code: "INVALID_DIRECT_TRANSFER_CODE" }, 400);
  }
  try {
    return c.json(await receiveDirectTransfer(envelope));
  } catch (err) {
    if (err instanceof InvalidDirectTransferCodeError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    if (err instanceof DirectTransferSessionError) {
      return c.json({ error: err.message, code: err.code }, 410);
    }
    if (err instanceof CloudInstanceNotTransferableError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    if (err instanceof InvalidTransferFileError || err instanceof WrongPassphraseError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    if (err instanceof PkCollisionError) {
      return c.json({ error: err.message, code: "PK_COLLISION" }, 409);
    }
    if (err instanceof MigrationAlreadyInProgressError || err instanceof MigrationLockAcquireError) {
      return c.json({ error: "The destination is busy. Generate a new code and try again shortly.", code: "BUSY" }, 503);
    }
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
    if (err instanceof CloudInstanceNotTransferableError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    if (err instanceof WrongPassphraseError || err instanceof InvalidTransferFileError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    if (err instanceof PkCollisionError) {
      return c.json(
        {
          error:
            "Some imported rows already exist on this instance. Use Replace mode, or remove the conflicting data first.",
          code: "PK_COLLISION",
        },
        409,
      );
    }
    if (
      err instanceof MigrationAlreadyInProgressError ||
      err instanceof MigrationLockAcquireError
    ) {
      return c.json(
        { error: "The instance is busy with another migration or import. Try again shortly.", code: "BUSY" },
        503,
      );
    }
    throw err;
  }
}
