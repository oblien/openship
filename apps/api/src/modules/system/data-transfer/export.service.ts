/**
 * Whole-instance export. Dumps every instance table, lifts each secret's
 * plaintext into a passphrase-sealed bundle, and strips the ciphertext from the
 * payload so the file carries secrets ONLY inside the sealed bundle.
 */

import { dumpSubgraph, stripEncryptedInPlace } from "@repo/db";

import { env } from "../../../config/env";
import { CloudInstanceNotTransferableError } from "./errors";
import { sealSecretBundle } from "./passphrase-crypto";
import { extractPlaintext } from "./secret-codec";
import { SECRET_COLUMNS } from "./secret-registry";
import type { DataTransferFile, SecretBundle, SecretEntry } from "./types";

export async function exportInstance(opts: { passphrase?: string }): Promise<DataTransferFile> {
  // GATE 1: never export a multi-tenant SaaS instance (would leak all tenants).
  if (env.CLOUD_MODE) throw new CloudInstanceNotTransferableError();

  const dump = await dumpSubgraph({ kind: "instance" });

  // Decrypt each secret cell (source instance can read its own data) into the
  // bundle BEFORE stripping the payload.
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

  // Now scrub ciphertext from the payload (idempotent with restore-side redaction).
  stripEncryptedInPlace(dump.tables);

  const bundle: SecretBundle = { version: 1, entries };
  const secrets =
    opts.passphrase && entries.length > 0 ? sealSecretBundle(bundle, opts.passphrase) : null;

  return {
    kind: "openship-instance-export",
    envelopeVersion: 1,
    createdAt: new Date().toISOString(),
    sourceDriver: dump.sourceDriver,
    dump,
    secrets,
  };
}
