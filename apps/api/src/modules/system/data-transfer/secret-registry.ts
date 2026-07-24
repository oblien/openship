/**
 * Maps every encrypted column (the single source of truth in @repo/db
 * `ENCRYPTED_COLUMNS`) to the crypto scheme used to seal it at rest. This
 * drives the export decrypt and the import re-encrypt. Kept in `apps/api`
 * because the crypto helpers live here and `packages/db` cannot import them.
 *
 * A build-time assertion below fails fast if `ENCRYPTED_COLUMNS` gains an
 * entry this registry doesn't know how to (de)crypt.
 */

import { db, eq, schema, ENCRYPTED_COLUMNS } from "@repo/db";

import type { SecretScheme } from "./types";

// Derived from drizzle's own signatures so we don't import drizzle-orm directly
// (it isn't a direct dependency of apps/api).
type AnyTable = Parameters<typeof db.update>[0];
type AnyColumn = Parameters<typeof eq>[0];

export interface SecretColumn {
  sqlName: string;
  table: AnyTable;
  pk: AnyColumn;
  column: string;
  scheme: SecretScheme;
  secretPaths?: string[];
}

/** table.column → { drizzle table, scheme }. Keys mirror ENCRYPTED_COLUMNS. */
const SCHEME_BY_KEY: Record<string, { table: AnyTable; scheme: SecretScheme }> = {
  "user_settings.cloudSessionToken": { table: schema.userSettings, scheme: "scalar" },
  "user_settings.cloneTokenEncrypted": { table: schema.userSettings, scheme: "scalar" },
  "project.cloneTokenEncrypted": { table: schema.project, scheme: "scalar" },
  "project.webhookSecret": { table: schema.project, scheme: "scalar" },
  "cloud_webhook_binding.webhookSecret": { table: schema.cloudWebhookBinding, scheme: "scalar" },
  "webhook_source.secret": { table: schema.webhookSource, scheme: "scalar" },
  "env_var.value": { table: schema.envVar, scheme: "scalar" },
  "backup_destination.accessKeyIdEnc": { table: schema.backupDestination, scheme: "enc1" },
  "backup_destination.secretAccessKeyEnc": { table: schema.backupDestination, scheme: "enc1" },
  "backup_destination.sftpPasswordEnc": { table: schema.backupDestination, scheme: "enc1" },
  "backup_destination.sftpPrivateKeyEnc": { table: schema.backupDestination, scheme: "enc1" },
  "backup_destination.sftpKeyPassphraseEnc": { table: schema.backupDestination, scheme: "enc1" },
  "servers.sshPassword": { table: schema.servers, scheme: "enc1" },
  "servers.sshKeyPassphrase": { table: schema.servers, scheme: "enc1" },
  "instance_settings.tunnelToken": { table: schema.instanceSettings, scheme: "plaintext" },
  "deployment.envVars": { table: schema.deployment, scheme: "map" },
  "notification_channel.config": { table: schema.notificationChannel, scheme: "notification-config" },
};

export const SECRET_COLUMNS: readonly SecretColumn[] = ENCRYPTED_COLUMNS.map((spec) => {
  const key = `${spec.table}.${spec.column}`;
  const meta = SCHEME_BY_KEY[key];
  if (!meta) {
    throw new Error(`data-transfer: no crypto scheme registered for encrypted column ${key}`);
  }
  return {
    sqlName: spec.table,
    table: meta.table,
    pk: (meta.table as unknown as { id: AnyColumn }).id,
    column: spec.column,
    scheme: meta.scheme,
    secretPaths: spec.secretPaths ? [...spec.secretPaths] : undefined,
  };
});
