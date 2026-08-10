/**
 * Wire types for whole-instance data export / import.
 *
 * The export file wraps an UNCHANGED `DatabaseDump` (so restoreSubgraph's
 * format-version gate is untouched) plus a passphrase-sealed bundle of every
 * secret's plaintext. The dump payload itself carries NO secret ciphertext —
 * secrets live only inside `secrets`, encrypted under the user's passphrase.
 */

import type { DatabaseDump } from "@repo/db";

export type ImportMode = "wipe" | "merge";

/** How a given column is encrypted at rest — drives decrypt/re-encrypt dispatch. */
export type SecretScheme = "scalar" | "enc1" | "map" | "notification-config" | "plaintext";

/** One secret cell's plaintext, keyed to its row. Only one payload field is set. */
export interface SecretEntry {
  table: string; // sqlName
  id: string; // row primary key
  column: string; // drizzle field name
  scheme: SecretScheme;
  /** scalar | enc1 | plaintext */
  value?: string;
  /** map — e.g. deployment.envVars */
  map?: Record<string, string>;
  /** notification-config — decrypted secret sub-fields only (hmacSecret, webhookUrl) */
  config?: Record<string, string>;
}

export interface SecretBundle {
  version: 1;
  entries: SecretEntry[];
}

/**
 * The secret bundle sealed for transport. `blob` is the app's standard
 * AES-256-GCM envelope (base64 iv||authTag||ciphertext) of
 * `JSON.stringify(SecretBundle)`, under a key = scrypt(passphrase, salt).
 */
export interface SealedSecrets {
  version: 1;
  kdf: { algo: "scrypt"; N: number; r: number; p: number; keyLen: number; salt: string };
  blob: string;
}

export interface DataTransferFile {
  kind: "openship-instance-export";
  envelopeVersion: 1;
  createdAt: string;
  sourceDriver: "pg" | "pglite";
  dump: DatabaseDump;
  /** null = the export carried no secrets (no passphrase given). */
  secrets: SealedSecrets | null;
}

export interface ImportResult {
  mode: ImportMode;
  rowsRestored: number;
  secretsRehydrated: number;
  /** true when the file had no secrets, or had secrets but no passphrase was supplied. */
  secretsSkipped: boolean;
  /**
   * Projects whose source is a LOCAL FOLDER path (localPath / folder-upload).
   * That path is machine-specific — it points at the SOURCE machine and almost
   * certainly does not exist on this install (e.g. a Mac path imported onto a
   * Linux server). The next deploy of these projects can't find the folder until
   * you re-point localPath (or re-deploy from a folder on THIS machine). Warn-only
   * — we never guess a rewrite. Empty when nothing needs attention.
   */
  localPathProjects: Array<{ slug: string; localPath: string }>;
}
