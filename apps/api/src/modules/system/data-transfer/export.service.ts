/**
 * Whole-instance export. Dumps every instance table, lifts each secret's
 * plaintext into a passphrase-sealed bundle, and strips the ciphertext from the
 * payload so the file carries secrets ONLY inside the sealed bundle.
 */

import { countInstanceSubgraphTables, dumpSubgraph, stripEncryptedInPlace } from "@repo/db";

import { env } from "../../../config/env";
import { CloudInstanceNotTransferableError } from "./errors";
import { sealSecretBundle } from "./passphrase-crypto";
import { extractPlaintext } from "./secret-codec";
import { SECRET_COLUMNS } from "./secret-registry";
import { resolveExportSelection, summarizeExportCounts } from "./selection";
import type { DataTransferFile, ExportPreview, ExportSelection, SecretBundle, SecretEntry } from "./types";

export async function previewInstanceExport(): Promise<ExportPreview> {
  if (env.CLOUD_MODE) throw new CloudInstanceNotTransferableError();
  return summarizeExportCounts(await countInstanceSubgraphTables());
}

/** Build a scrubbed snapshot plus its in-memory plaintext credential bundle. */
export async function prepareInstanceExport(
  selectionInput?: ExportSelection,
): Promise<{ file: DataTransferFile; secrets: SecretBundle | null }> {
  if (env.CLOUD_MODE) throw new CloudInstanceNotTransferableError();

  const { selection, excludedTables } = resolveExportSelection(selectionInput);
  const dump = await dumpSubgraph({ kind: "instance" }, { excludeTables: excludedTables });

  const entries: SecretEntry[] = [];
  for (const spec of SECRET_COLUMNS) {
    const rows = dump.tables[spec.sqlName];
    if (!rows) continue;
    for (const row of rows) {
      const id = row.id;
      if (typeof id !== "string") continue;
      const entry = extractPlaintext(spec, id, row[spec.column]);
      if (entry) entries.push(entry);
    }
  }

  stripEncryptedInPlace(dump.tables);

  return {
    file: {
      kind: "openship-instance-export",
      envelopeVersion: 1,
      createdAt: new Date().toISOString(),
      sourceDriver: dump.sourceDriver,
      selection,
      summary: {
        rows: Object.values(dump.tables).reduce((count, rows) => count + rows.length, 0),
        tables: Object.keys(dump.tables).length,
      },
      dump,
      secrets: null,
    },
    secrets: entries.length > 0 ? { version: 1, entries } : null,
  };
}

export async function exportInstance(opts: {
  passphrase?: string;
  selection?: ExportSelection;
}): Promise<DataTransferFile> {
  const prepared = await prepareInstanceExport(opts.selection);
  return {
    ...prepared.file,
    secrets:
      opts.passphrase && prepared.secrets
        ? sealSecretBundle(prepared.secrets, opts.passphrase)
        : null,
  };
}
