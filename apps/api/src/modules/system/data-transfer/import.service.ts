/**
 * Whole-instance import. Validates the envelope, opens the secret bundle FIRST
 * (a wrong passphrase aborts before any DB write), restores the dump under the
 * migration lock, then re-encrypts each secret under THIS instance's key. The
 * row restore and those secret writes share one database transaction.
 *
 *   wipe  — truncate + insert everything; re-hydrate every restored row.
 *   merge — insert new rows only (singleton/auth rows kept via onConflictDoNothing);
 *           re-hydrate ONLY rows this import actually inserted, so a pre-existing
 *           row's own secrets are never clobbered.
 */

import { db, eq, inArray, restoreSubgraphInTransaction, type DatabaseTransaction } from "@repo/db";

import { env } from "../../../config/env";
import { reconcileRuntimeStateAfterImport } from "../../../lib/database-runtime-state";
import { reassertMigrationLockAfterRestore, withMigrationLock } from "../migration/migration-lock";
import { CloudInstanceNotTransferableError } from "./errors";
import { openTransferSecrets } from "./passphrase-crypto";
import { sealForInstance } from "./secret-codec";
import { SECRET_COLUMNS, type SecretColumn } from "./secret-registry";
import type {
  DataTransferFile,
  ImportMode,
  ImportResult,
  SecretBundle,
  SecretEntry,
} from "./types";

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
  "job",
];

const SECRET_SPEC_BY_KEY = new Map<string, SecretColumn>(
  SECRET_COLUMNS.map((spec) => [`${spec.sqlName}.${spec.column}`, spec]),
);

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

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

function assertValidSecretBundle(bundle: SecretBundle | null): void {
  if (!bundle) return;
  if (bundle.version !== 1 || !Array.isArray(bundle.entries)) {
    throw new InvalidTransferFileError("The credential bundle is invalid.");
  }
  const schemes = new Set(["scalar", "enc1", "map", "notification-config", "plaintext"]);
  for (const entry of bundle.entries) {
    if (
      !entry ||
      typeof entry.table !== "string" ||
      typeof entry.id !== "string" ||
      typeof entry.column !== "string" ||
      !schemes.has(entry.scheme)
    ) {
      throw new InvalidTransferFileError("The credential bundle contains an invalid entry.");
    }
    const knownSpec = SECRET_SPEC_BY_KEY.get(`${entry.table}.${entry.column}`);
    if (knownSpec && entry.scheme !== knownSpec.scheme) {
      throw new InvalidTransferFileError(
        "The credential bundle does not match the destination schema.",
      );
    }
    const validValue =
      entry.scheme === "map"
        ? isStringRecord(entry.map)
        : entry.scheme === "notification-config"
          ? isStringRecord(entry.config)
          : typeof entry.value === "string";
    if (!validValue) {
      throw new InvalidTransferFileError("The credential bundle contains an invalid secret value.");
    }
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
const ID_LOOKUP_BATCH_SIZE = 10_000;

async function computeNewIds(
  file: DataTransferFile,
  tx: DatabaseTransaction,
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  for (const [sqlName, { table, pk }] of secretTables()) {
    const dumpIds = (file.dump.tables[sqlName] ?? [])
      .map((r) => r.id)
      .filter((v): v is string => typeof v === "string");
    if (dumpIds.length === 0) {
      result.set(sqlName, new Set());
      continue;
    }
    const existingSet = new Set<string>();
    // Keep merge preflight below the driver's bind-parameter ceiling just like
    // restoreSubgraph's inserts. Large env-var/deployment histories can easily
    // contain tens of thousands of secret-bearing rows.
    for (let i = 0; i < dumpIds.length; i += ID_LOOKUP_BATCH_SIZE) {
      const existing = (await tx
        .select()
        .from(table)
        .where(inArray(pk, dumpIds.slice(i, i + ID_LOOKUP_BATCH_SIZE)))) as Array<
        Record<string, unknown>
      >;
      for (const row of existing) existingSet.add(row.id as string);
    }
    result.set(sqlName, new Set(dumpIds.filter((id) => !existingSet.has(id))));
  }
  return result;
}

export async function importInstance(opts: {
  file: DataTransferFile;
  passphrase?: string;
  mode: ImportMode;
  onBeforeCommit?: (tx: DatabaseTransaction, result: ImportResult) => Promise<void>;
}): Promise<ImportResult> {
  if (env.CLOUD_MODE) throw new CloudInstanceNotTransferableError();
  assertValidEnvelope(opts.file);
  return importPreparedInstance({
    file: opts.file,
    secrets: openTransferSecrets(opts.file.secrets, opts.passphrase),
    mode: opts.mode,
    onBeforeCommit: opts.onBeforeCommit,
  });
}

/** Restore a snapshot whose credential bundle has already been authenticated. */
export async function importPreparedInstance(opts: {
  file: DataTransferFile;
  secrets: SecretBundle | null;
  mode: ImportMode;
  onBeforeCommit?: (tx: DatabaseTransaction, result: ImportResult) => Promise<void>;
}): Promise<ImportResult> {
  const { file, mode, secrets: bundle } = opts;
  // GATE 1: never import (esp. wipe) onto a multi-tenant SaaS instance — a
  // wipe restore TRUNCATEs every tenant. Refuse before opening the bundle.
  if (env.CLOUD_MODE) throw new CloudInstanceNotTransferableError();
  assertValidEnvelope(file);
  assertValidSecretBundle(bundle);

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
    await db.transaction(async (rawTx) => {
      const tx = rawTx as DatabaseTransaction;
      const newIds = mode === "merge" ? await computeNewIds(file, tx) : null;

      await restoreSubgraphInTransaction(tx, file.dump, {
        mode,
        mergeConflictSkip: mode === "merge" ? SINGLETON_AND_AUTH : undefined,
      });

      if (bundle) {
        // Group secret entries by row so a row with several secret columns
        // (backup_destination, servers) gets one UPDATE.
        type RowPatch = {
          spec: SecretColumn;
          entries: Array<{ spec: SecretColumn; entry: SecretEntry }>;
        };
        const rows = new Map<string, RowPatch>();
        for (const entry of bundle.entries) {
          if (mode === "merge" && !newIds?.get(entry.table)?.has(entry.id)) continue;
          const spec = SECRET_SPEC_BY_KEY.get(`${entry.table}.${entry.column}`);
          if (!spec) continue;
          const key = `${entry.table}::${entry.id}`;
          const patch = rows.get(key) ?? { spec, entries: [] };
          patch.entries.push({ spec, entry });
          rows.set(key, patch);
        }

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
            currentCell =
              current?.[entries.find((e) => e.spec.scheme === "notification-config")!.spec.column];
          }

          const set: Record<string, unknown> = {};
          for (const { spec, entry } of entries) {
            set[spec.column] = sealForInstance(spec, entry, currentCell);
          }
          const updated = await tx
            .update(rowSpec.table)
            .set(set)
            .where(eq(rowSpec.pk, id))
            .returning();
          if (updated.length > 0) secretsRehydrated += 1;
        }
      }

      await opts.onBeforeCommit?.(tx, {
        mode,
        rowsRestored,
        secretsRehydrated,
        secretsSkipped,
        localPathProjects,
      });

      // A wipe replaces instance_settings, including the row carrying the lock
      // acquired above. Reassert it as the final transactional write so no new
      // mutation can enter between commit and runtime-state reconciliation.
      await reassertMigrationLockAfterRestore(tx);
    });

    // The database commit is the atomic boundary. Everything cached above it
    // must now forget the previous instance before the quiesce lock is released.
    // This hook owns its own error handling: a committed destructive import must
    // never be reported as failed/retryable.
    await reconcileRuntimeStateAfterImport();
  });

  return { mode, rowsRestored, secretsRehydrated, secretsSkipped, localPathProjects };
}
