/**
 * HTTP surface for whole-instance data export / import (self-hosted only,
 * owner-only — enforced by the route's requireRole("owner")).
 *
 *   POST /api/system/data-transfer/export  — { passphrase? } → DataTransferFile
 *   POST /api/system/data-transfer/import   — { file, passphrase?, mode } → ImportResult
 */

import type { Context } from "hono";
import { PkCollisionError } from "@repo/db";

import { audit, auditContextFrom } from "../../../lib/audit";
import { getRequestContext } from "../../../lib/request-context";
import {
  MigrationAlreadyInProgressError,
  MigrationLockAcquireError,
} from "../migration/migration-lock";
import { exportInstance } from "./export.service";
import { CloudInstanceNotTransferableError } from "./errors";
import { importInstance, InvalidTransferFileError } from "./import.service";
import { WrongPassphraseError } from "./passphrase-crypto";
import type { DataTransferFile, ImportMode } from "./types";

interface ExportBody {
  passphrase?: string;
}
interface ImportBody {
  file?: DataTransferFile;
  passphrase?: string;
  mode?: ImportMode;
}

function readPassphrase(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export async function exportInstanceHandler(c: Context) {
  const ctx = getRequestContext(c);
  const body = ((await c.req.json<ExportBody>().catch(() => ({}))) ?? {}) as ExportBody;

  let file: DataTransferFile;
  try {
    file = await exportInstance({ passphrase: readPassphrase(body.passphrase) });
  } catch (err) {
    if (err instanceof CloudInstanceNotTransferableError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    throw err;
  }

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "instance.data.exported",
    resourceType: "instance",
    after: { hasSecrets: !!file.secrets, tableCount: Object.keys(file.dump.tables).length },
  });

  return c.json(file);
}

export async function importInstanceHandler(c: Context) {
  const ctx = getRequestContext(c);

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
