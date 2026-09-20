/**
 * Scoped control-plane import. Validates the envelope, opens the secret bundle FIRST
 * (a wrong passphrase aborts before any DB write), restores the dump under the
 * migration lock, then re-encrypts each secret under THIS instance's key. The
 * row restore and those secret writes share one database transaction.
 *
 *   wipe  — truncate + insert everything; re-hydrate every restored row.
 *   merge — insert new rows only (singleton/auth rows kept via onConflictDoNothing);
 *           re-hydrate ONLY rows this import actually inserted, so a pre-existing
 *           row's own secrets are never clobbered.
 * Project imports additionally resolve destination identities and allow explicit
 * updates to matching project records; they can never wipe an instance.
 */

import {
  db,
  eq,
  inArray,
  restoreSubgraphInTransaction,
  schema,
  transferProject,
  type DatabaseTransaction,
} from "@repo/db";

import { env } from "@repo/platform/engine/config/env";
import { reconcileRuntimeStateAfterImport } from "../../../lib/database-runtime-state";
import { reassertMigrationLockAfterRestore, withMigrationLock } from "../migration/migration-lock";
import { CloudInstanceNotTransferableError } from "./errors";
import { openTransferSecrets } from "./passphrase-crypto";
import { sealForInstance } from "./secret-codec";
import { SECRET_COLUMNS, stripTransferSecrets, type SecretColumn } from "./secret-registry";
import {
  planProjectImport,
  ProjectImportError,
  remapProjectSecrets,
  validateImportSelection,
  type ImportContext,
} from "./project-import";
import { summarizeExportCounts } from "./selection";
import { transferServer } from "./export.service";
import { getCloudConnectionStatusForOrg } from "@repo/platform/engine/lib/cloud/session";
import type {
  DataTransferFile,
  ImportMode,
  ImportResult,
  SecretBundle,
  SecretEntry,
  ImportSelection,
  ImportPreview,
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

export function assertValidEnvelope(file: DataTransferFile): void {
  if (
    !file ||
    (file.kind !== "openship-instance-export" && file.kind !== "openship-project-export")
  ) {
    throw new InvalidTransferFileError("Not an Openship export file.");
  }
  if (file.envelopeVersion !== 1 && file.envelopeVersion !== 2) {
    throw new InvalidTransferFileError(
      `Unsupported export version ${file.envelopeVersion}; this build reads versions 1 and 2.`,
    );
  }
  if (
    (file.kind === "openship-instance-export" && file.dump?.scope?.kind !== "instance") ||
    (file.kind === "openship-project-export" && file.dump?.scope?.kind !== "project")
  ) {
    throw new InvalidTransferFileError("The export scope does not match its contents.");
  }
  if (
    file.dump.formatVersion !== 1 ||
    !file.dump.tables ||
    typeof file.dump.tables !== "object" ||
    Array.isArray(file.dump.tables) ||
    Object.values(file.dump.tables).some(
      (rows) =>
        !Array.isArray(rows) ||
        rows.some((row) => !row || typeof row !== "object" || Array.isArray(row)),
    )
  ) {
    throw new InvalidTransferFileError("The export contains an invalid database snapshot.");
  }
  if (
    file.manifest &&
    (!Array.isArray(file.manifest.projects) ||
      !Array.isArray(file.manifest.servers) ||
      !Array.isArray(file.manifest.cloudAccounts) ||
      !Array.isArray(file.manifest.warnings) ||
      file.manifest.warnings.some((warning) => typeof warning !== "string") ||
      file.manifest.servers.some(
        (server) =>
          !server ||
          typeof server.id !== "string" ||
          typeof server.host !== "string" ||
          typeof server.name !== "string" ||
          !Number.isSafeInteger(server.port) ||
          server.port < 1 ||
          server.port > 65535 ||
          typeof server.isLocal !== "boolean" ||
          typeof server.included !== "boolean" ||
          typeof server.hasCredentials !== "boolean" ||
          (server.jumpHost !== undefined &&
            server.jumpHost !== null &&
            typeof server.jumpHost !== "string"),
      ) ||
      file.manifest.cloudAccounts.some(
        (account) =>
          !account ||
          typeof account.organizationId !== "string" ||
          (account.email !== null && typeof account.email !== "string"),
      ))
  ) {
    throw new InvalidTransferFileError("The export manifest is invalid.");
  }
}

function assertValidSecretBundle(bundle: SecretBundle | null): void {
  if (!bundle) return;
  if (bundle.version !== 1 || !Array.isArray(bundle.entries)) {
    throw new InvalidTransferFileError("The credential bundle is invalid.");
  }
  const schemes = new Set(["scalar", "enc1", "map", "notification-config", "plaintext", "json"]);
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
      entry.scheme === "json"
        ? entry.json !== null && typeof entry.json === "object"
        : entry.scheme === "map"
          ? isStringRecord(entry.map)
          : entry.scheme === "notification-config"
            ? isStringRecord(entry.config)
            : typeof entry.value === "string";
    if (!validValue) {
      throw new InvalidTransferFileError("The credential bundle contains an invalid secret value.");
    }
  }
}

export async function previewInstanceImport(opts: {
  file: DataTransferFile;
  selection?: ImportSelection;
  context: ImportContext;
}): Promise<ImportPreview> {
  if (env.CLOUD_MODE) throw new CloudInstanceNotTransferableError();
  assertValidEnvelope(opts.file);
  validateImportSelection(opts.selection);
  const scope =
    opts.selection?.scope ??
    (opts.file.kind === "openship-project-export" ? "projects" : "instance");
  if (scope === "projects")
    return (await planProjectImport(opts.file, { ...opts.selection, scope }, opts.context)).preview;
  if (opts.file.kind === "openship-project-export")
    throw new ProjectImportError(
      "A project archive cannot replace an instance. Choose project import.",
    );
  const servers = await db.select().from(schema.servers);
  return {
    scope,
    projects: (opts.file.dump.tables.project ?? []).map((row) => ({
      ...transferProject(row),
      action: "create" as const,
    })),
    servers: (opts.file.dump.tables.servers ?? []).map((row) => ({
      ...transferServer(row),
      action: "create" as const,
    })),
    availableServers: servers
      .filter((row) => !row.organizationId || row.organizationId === opts.context.organizationId)
      .map((row) => transferServer(row)),
    history: summarizeExportCounts(
      Object.fromEntries(
        Object.entries(opts.file.dump.tables).map(([name, rows]) => [name, rows.length]),
      ),
    ).history,
    rows: Object.values(opts.file.dump.tables).reduce((n, rows) => n + rows.length, 0),
    hasSecrets: !!opts.file.secrets,
    warnings: opts.file.manifest?.warnings ?? [],
    blockers: [],
  };
}

export async function importInstance(opts: {
  file: DataTransferFile;
  passphrase?: string;
  mode: ImportMode;
  selection?: ImportSelection;
  context?: ImportContext;
  onBeforeCommit?: (tx: DatabaseTransaction, result: ImportResult) => Promise<void>;
}): Promise<ImportResult> {
  if (env.CLOUD_MODE) throw new CloudInstanceNotTransferableError();
  assertValidEnvelope(opts.file);
  return importPreparedInstance({
    file: opts.file,
    secrets:
      opts.selection?.includeSecrets === false
        ? null
        : openTransferSecrets(opts.file.secrets, opts.passphrase),
    mode: opts.mode,
    selection: opts.selection,
    context: opts.context,
    onBeforeCommit: opts.onBeforeCommit,
  });
}

/** Restore a snapshot whose credential bundle has already been authenticated. */
export async function importPreparedInstance(opts: {
  file: DataTransferFile;
  secrets: SecretBundle | null;
  mode: ImportMode;
  selection?: ImportSelection;
  context?: ImportContext;
  onBeforeCommit?: (tx: DatabaseTransaction, result: ImportResult) => Promise<void>;
}): Promise<ImportResult> {
  const { mode } = opts;
  let file = opts.file;
  let bundle = opts.selection?.includeSecrets === false ? null : opts.secrets;
  // GATE 1: never import (esp. wipe) onto a multi-tenant SaaS instance — a
  // wipe restore TRUNCATEs every tenant. Refuse before opening the bundle.
  if (env.CLOUD_MODE) throw new CloudInstanceNotTransferableError();
  assertValidEnvelope(file);
  assertValidSecretBundle(bundle);
  validateImportSelection(opts.selection);
  if (opts.selection?.includeSecrets === false) {
    file = {
      ...file,
      dump: {
        ...file.dump,
        tables: Object.fromEntries(
          Object.entries(file.dump.tables).map(([name, rows]) => [
            name,
            rows.map((row) => ({ ...row })),
          ]),
        ),
      },
    };
    stripTransferSecrets(file.dump.tables);
  }
  const projectScope =
    opts.selection?.scope === "projects" || file.kind === "openship-project-export";
  if (file.kind === "openship-project-export" && opts.selection?.scope === "instance")
    throw new ProjectImportError("A project archive cannot replace an instance.");
  if (projectScope && mode === "wipe")
    throw new ProjectImportError(
      "Project imports cannot wipe an instance. Use merge with project overwrite options.",
    );
  if (projectScope && !opts.context)
    throw new ProjectImportError(
      "Project import requires a destination workspace. Import this archive from Settings on the destination.",
    );

  const secretsSkipped = !bundle;

  let rowsRestored = 0;

  // Local-folder (localPath / folder-upload) projects carry a SOURCE-machine path
  // that won't exist on this install — surface them so the operator re-points or
  // re-deploys instead of hitting a "folder not found" on the next deploy.
  let localPathProjects = (file.dump.tables["project"] ?? [])
    .filter((r) => typeof r.localPath === "string" && (r.localPath as string).trim() !== "")
    .map((r) => ({ slug: String(r.slug ?? r.id ?? "?"), localPath: String(r.localPath) }));

  let secretsRehydrated = 0;
  let projectPreview: ImportPreview | undefined;
  // Resolve cloud identity before opening the DB transaction. PGlite has one
  // connection; a global repo query inside its transaction would deadlock.
  const cloud =
    projectScope && file.dump.tables.project?.some((row) => row.cloudWorkspaceId)
      ? await getCloudConnectionStatusForOrg(opts.context!.organizationId)
      : undefined;

  await withMigrationLock(async () => {
    await db.transaction(async (rawTx) => {
      const tx = rawTx as DatabaseTransaction;
      let updateTables: string[] | undefined;
      let retargetedDeployments: string[] = [];
      if (projectScope) {
        const plan = await planProjectImport(
          file,
          { ...opts.selection, scope: "projects" },
          opts.context!,
          tx,
          cloud,
        );
        if (plan.preview.blockers.length)
          throw new ProjectImportError(plan.preview.blockers.join("\n"));
        projectPreview = plan.preview;
        file = { ...file, dump: plan.dump };
        bundle = remapProjectSecrets(bundle, plan);
        updateTables = plan.updateTables;
        retargetedDeployments = [...plan.retargetedDeployments];
        localPathProjects = (file.dump.tables.project ?? [])
          .filter((row) => row.localPath)
          .map((row) => ({ slug: String(row.slug), localPath: String(row.localPath) }));
      }
      const writtenIds = new Map<string, Set<string>>();
      const writtenRows = { count: 0 };
      const preserveColumns: Record<string, string[]> = {};
      for (const spec of SECRET_COLUMNS) (preserveColumns[spec.sqlName] ??= []).push(spec.column);

      await restoreSubgraphInTransaction(tx, file.dump, {
        mode,
        mergeConflictSkip: mode === "merge" ? SINGLETON_AND_AUTH : undefined,
        mergeConflictUpdate: updateTables,
        mergePreserveColumns: preserveColumns,
        writtenIds,
        writtenRows,
      });
      rowsRestored = writtenRows.count;
      // Unlike an ordinary overwrite, a changed host invalidates even the
      // destination's previous frozen runtime snapshot. Its secrets must not
      // reintroduce source-host bindings later in this transaction.
      for (let i = 0; i < retargetedDeployments.length; i += 5_000) {
        await tx
          .update(schema.deployment)
          .set({ meta: null })
          .where(inArray(schema.deployment.id, retargetedDeployments.slice(i, i + 5_000)));
      }

      if (bundle) {
        // Group secret entries by row so a row with several secret columns
        // (backup_destination, servers) gets one UPDATE.
        type RowPatch = {
          spec: SecretColumn;
          entries: Array<{ spec: SecretColumn; entry: SecretEntry }>;
        };
        const rows = new Map<string, RowPatch>();
        for (const entry of bundle.entries) {
          if (!writtenIds.get(entry.table)?.has(entry.id)) continue;
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
        ...(projectPreview ? projectResult(projectPreview) : {}),
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

  return {
    mode,
    rowsRestored,
    secretsRehydrated,
    secretsSkipped,
    localPathProjects,
    ...(projectPreview ? projectResult(projectPreview) : {}),
  };
}

function projectResult(preview: ImportPreview) {
  return {
    warnings: preview.warnings,
    projectsCreated: preview.projects.filter((row) => row.action === "create").length,
    projectsUpdated: preview.projects.filter((row) => row.action === "overwrite").length,
    projectsSkipped: preview.projects.filter((row) => row.action === "skip").length,
  };
}
