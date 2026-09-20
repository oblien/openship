/**
 * Maps every encrypted column (the single source of truth in @repo/db
 * `ENCRYPTED_COLUMNS`) to the crypto scheme used to seal it at rest. This
 * drives export decryption and import re-encryption. The transfer coordinator
 * binds the shared codecs to the source or destination installation's key.
 *
 * A build-time assertion below fails fast if `ENCRYPTED_COLUMNS` gains an
 * entry this registry doesn't know how to (de)crypt.
 */

import {
  db,
  eq,
  schema,
  ENCRYPTED_COLUMNS,
  stripEncryptedInPlace,
  type DatabaseDump,
} from "@repo/db";

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
  "incoming_webhook.tokenEncrypted": { table: schema.incomingWebhook, scheme: "scalar" },
  "incoming_webhook.hmacSecretEncrypted": { table: schema.incomingWebhook, scheme: "scalar" },
  "env_var.value": { table: schema.envVar, scheme: "scalar" },
  "backup_destination.accessKeyIdEnc": { table: schema.backupDestination, scheme: "enc1" },
  "backup_destination.secretAccessKeyEnc": { table: schema.backupDestination, scheme: "enc1" },
  "backup_destination.sftpPasswordEnc": { table: schema.backupDestination, scheme: "enc1" },
  "backup_destination.sftpPrivateKeyEnc": { table: schema.backupDestination, scheme: "enc1" },
  "backup_destination.sftpKeyPassphraseEnc": { table: schema.backupDestination, scheme: "enc1" },
  "dns_credential.apiTokenEnc": { table: schema.dnsCredential, scheme: "enc1" },
  "credential.secretsEnc": { table: schema.credential, scheme: "enc1" },
  "git_source.secretsEnc": { table: schema.gitSource, scheme: "enc1" },
  "servers.sshPassword": { table: schema.servers, scheme: "enc1" },
  "servers.sshPrivateKey": { table: schema.servers, scheme: "enc1" },
  "servers.sshKeyPassphrase": { table: schema.servers, scheme: "enc1" },
  // scalar, not enc1: server-github.service seals these with encrypt()/decrypt().
  "server_github_auth.tokenEncrypted": { table: schema.serverGithubAuth, scheme: "scalar" },
  "server_github_auth.serverKeyPrivateEncrypted": {
    table: schema.serverGithubAuth,
    scheme: "scalar",
  },
  "github_deploy_key.privateKeyEncrypted": { table: schema.githubDeployKey, scheme: "scalar" },
  // Plaintext at rest (the Better Auth plugin owns the column) — "plaintext" moves it
  // into the sealed bundle verbatim rather than pretending it was encrypted.
  "oauth_application.clientSecret": { table: schema.oauthApplication, scheme: "plaintext" },
  "instance_settings.tunnelToken": { table: schema.instanceSettings, scheme: "plaintext" },
  "instance_settings.ghDeviceTokenEncrypted": { table: schema.instanceSettings, scheme: "scalar" },
  "deployment.envVars": { table: schema.deployment, scheme: "map" },
  "deployment.meta": { table: schema.deployment, scheme: "json" },
  "service.environment": { table: schema.service, scheme: "json" },
  "service.buildArgs": { table: schema.service, scheme: "json" },
  "service.advanced": { table: schema.service, scheme: "json" },
  "service.importedSpec": { table: schema.service, scheme: "json" },
  "service.driftSpec": { table: schema.service, scheme: "json" },
  "edge_target_verification.token": { table: schema.edgeTargetVerification, scheme: "plaintext" },
  "edge_target_verification.retiredTokens": {
    table: schema.edgeTargetVerification,
    scheme: "json",
  },
  "backup_policy.webhookToken": { table: schema.backupPolicy, scheme: "plaintext" },
  "account.accessToken": { table: schema.account, scheme: "plaintext" },
  "account.refreshToken": { table: schema.account, scheme: "plaintext" },
  "account.idToken": { table: schema.account, scheme: "plaintext" },
  "notification_channel.config": {
    table: schema.notificationChannel,
    scheme: "notification-config",
  },
};

// File/direct transfers also remove non-encrypted sensitive configuration. The
// service fields are included here to keep legacy export redaction identical.
const TRANSFER_CONFIG_COLUMNS = [
  { table: "deployment", column: "meta" },
  { table: "service", column: "environment" },
  { table: "service", column: "buildArgs" },
  { table: "service", column: "advanced" },
  { table: "service", column: "importedSpec" },
  { table: "service", column: "driftSpec" },
  { table: "edge_target_verification", column: "token" },
  { table: "edge_target_verification", column: "retiredTokens" },
  { table: "backup_policy", column: "webhookToken" },
  { table: "account", column: "accessToken" },
  { table: "account", column: "refreshToken" },
  { table: "account", column: "idToken" },
];

export const SECRET_COLUMNS: readonly SecretColumn[] = [
  ...ENCRYPTED_COLUMNS,
  ...TRANSFER_CONFIG_COLUMNS.filter(
    (spec) =>
      !ENCRYPTED_COLUMNS.some(
        (encrypted) => encrypted.table === spec.table && encrypted.column === spec.column,
      ),
  ),
].map((spec) => {
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
    secretPaths:
      "secretPaths" in spec && Array.isArray(spec.secretPaths) ? [...spec.secretPaths] : undefined,
  };
});

export function stripTransferSecrets(tables: DatabaseDump["tables"]): void {
  stripEncryptedInPlace(tables);
  for (const spec of TRANSFER_CONFIG_COLUMNS) {
    for (const row of tables[spec.table] ?? []) {
      if (spec.table === "deployment" && spec.column === "meta") {
        // Frozen Compose services can contain inline credentials. Keep only
        // target identity outside the sealed snapshot so a password-free review
        // can still discover historical server dependencies and plan mappings.
        const meta = row.meta;
        if (meta && typeof meta === "object") {
          row.meta = Object.fromEntries(
            Object.entries(meta).filter(
              ([key, value]) =>
                ["organizationId", "serverId", "deployTarget", "runtimeMode"].includes(key) &&
                typeof value === "string",
            ),
          );
        }
        continue;
      }
      // JSON config columns have nullable/default values in the schema.
      delete row[spec.column];
    }
  }
}
