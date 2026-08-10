/**
 * Whole-instance import. Validates the envelope, opens the secret bundle FIRST
 * (a wrong passphrase aborts before any DB write), restores the dump under the
 * migration lock, then re-encrypts each secret under THIS instance's key and
 * writes it back.
 *
 *   wipe  — truncate + insert everything; re-hydrate every restored row.
 *   merge — insert new rows only (singleton/auth rows kept via onConflictDoNothing);
 *           re-hydrate ONLY rows this import actually inserted, so a pre-existing
 *           row's own secrets are never clobbered.
 */

import { db, eq, inArray, restoreSubgraph } from "@repo/db";

import { env } from "../../../config/env";
import { withMigrationLock } from "../migration/migration-lock";
import { CloudInstanceNotTransferableError } from "./errors";
import { openSecretBundle } from "./passphrase-crypto";
import { sealForInstance } from "./secret-codec";
import { SECRET_COLUMNS, type SecretColumn } from "./secret-registry";
import type { DataTransferFile, ImportMode, ImportResult, SecretBundle, SecretEntry } from "./types";

export class InvalidTransferFileError extends Error {
  readonly code = "INVALID_TRANSFER_FILE" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransferFileError";
  }
}

/**
 * Singleton + auth/identity tables that always exist on any install. On MERGE
 * we keep the destination's own copies (onConflictDoNothing) rather than fail
 * on their guaranteed PK collision, and we never re-hydrate secrets onto them.
 */
const SINGLETON_AND_AUTH = [
  "instance_settings",
  "user",
  "account",
  "session",
  "organization",
  "member",
  "invitation",
  "invitation_pending_grant",
  "resource_grant",
  "user_settings",
];

function assertValidEnvelope(file: DataTransferFile): void {
  if (!file || file.kind !== "openship-instance-export") {
    throw new InvalidTransferFileError("Not an Openship instance export file.");
  }
  if (file.envelopeVersion !== 1) {
    throw new InvalidTransferFileError(
      `Unsupported export version ${file.envelopeVersion}; this build reads version 1.`,
    );
  }
  if (file.dump?.scope?.kind !== "instance") {
    throw new InvalidTransferFileError("Import requires a whole-instance export.");
  }
}

/** Distinct secret tables → their drizzle table + pk column. */
function secretTables(): Map<string, { table: SecretColumn["table"]; pk: SecretColumn["pk"] }> {
  const out = new Map<string, { table: SecretColumn["table"]; pk: SecretColumn["pk"] }>();
  for (const spec of SECRET_COLUMNS) {
    if (!out.has(spec.sqlName)) out.set(spec.sqlName, { table: spec.table, pk: spec.pk });
  }
  return out;
}

/** merge only: which ids in each secret table are NEW (didn't already exist). */
async function computeNewIds(file: DataTransferFile): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  for (const [sqlName, { table, pk }] of secretTables()) {
    const dumpIds = (file.dump.tables[sqlName] ?? [])
      .map((r) => r.id)
      .filter((v): v is string => typeof v === "string");
    if (dumpIds.length === 0) {
      result.set(sqlName, new Set());
      continue;
    }
    const existing = (await db
      .select()
      .from(table)
      .where(inArray(pk, dumpIds))) as Array<Record<string, unknown>>;
    const existingSet = new Set(existing.map((r) => r.id as string));
    result.set(sqlName, new Set(dumpIds.filter((id) => !existingSet.has(id))));
  }
  return result;
}

export async function importInstance(opts: {
  file: DataTransferFile;
  passphrase?: string;
  mode: ImportMode;
}): Promise<ImportResult> {
  const { file, mode } = opts;
  // GATE 1: never import (esp. wipe) onto a multi-tenant SaaS instance — a
  // wipe restore TRUNCATEs every tenant. Refuse before opening the bundle.
  if (env.CLOUD_MODE) throw new CloudInstanceNotTransferableError();
  assertValidEnvelope(file);

  // Open the bundle FIRST — a wrong passphrase throws here, before any write.
  let bundle: SecretBundle | null = null;
  if (file.secrets && opts.passphrase) {
    bundle = openSecretBundle(file.secrets, opts.passphrase);
  }
  const secretsSkipped = !bundle;

  const rowsRestored = Object.values(file.dump.tables).reduce((n, rows) => n + rows.length, 0);

  // Local-folder (localPath / folder-upload) projects carry a SOURCE-machine path
  // that won't exist on this install — surface them so the operator re-points or
  // re-deploys instead of hitting a "folder not found" on the next deploy.
  const localPathProjects = (file.dump.tables["project"] ?? [])
    .filter((r) => typeof r.localPath === "string" && (r.localPath as string).trim() !== "")
    .map((r) => ({ slug: String(r.slug ?? r.id ?? "?"), localPath: String(r.localPath) }));

  let secretsRehydrated = 0;

  await withMigrationLock(async () => {
    const newIds = mode === "merge" ? await computeNewIds(file) : null;

    await restoreSubgraph(file.dump, {
      mode,
      mergeConflictSkip: mode === "merge" ? SINGLETON_AND_AUTH : undefined,
    });

    if (!bundle) return;

    // Group secret entries by row so a row with several secret columns
    // (backup_destination, servers) gets one UPDATE.
    const specByKey = new Map<string, SecretColumn>();
    for (const spec of SECRET_COLUMNS) specByKey.set(`${spec.sqlName}.${spec.column}`, spec);

    type RowPatch = { spec: SecretColumn; entries: Array<{ spec: SecretColumn; entry: SecretEntry }> };
    const rows = new Map<string, RowPatch>();
    for (const entry of bundle.entries) {
      if (mode === "merge" && !newIds?.get(entry.table)?.has(entry.id)) continue;
      const spec = specByKey.get(`${entry.table}.${entry.column}`);
      if (!spec) continue;
      const key = `${entry.table}::${entry.id}`;
      const patch = rows.get(key) ?? { spec, entries: [] };
      patch.entries.push({ spec, entry });
      rows.set(key, patch);
    }

    await db.transaction(async (tx) => {
      for (const { spec: rowSpec, entries } of rows.values()) {
        const id = entries[0]!.entry.id;

        // notification-config re-hydration merges secrets back into the
        // restored (scrubbed) config, so read it first.
        let currentCell: unknown;
        if (entries.some((e) => e.spec.scheme === "notification-config")) {
          const [current] = (await tx
            .select()
            .from(rowSpec.table)
            .where(eq(rowSpec.pk, id))
            .limit(1)) as Array<Record<string, unknown>>;
          currentCell = current?.[entries.find((e) => e.spec.scheme === "notification-config")!.spec.column];
        }

        const set: Record<string, unknown> = {};
        for (const { spec, entry } of entries) {
          set[spec.column] = sealForInstance(spec, entry, currentCell);
        }
        await tx.update(rowSpec.table).set(set).where(eq(rowSpec.pk, id));
        secretsRehydrated += 1;
      }
    });
  });

  return { mode, rowsRestored, secretsRehydrated, secretsSkipped, localPathProjects };
}
