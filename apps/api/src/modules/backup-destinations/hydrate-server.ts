/**
 * Translate an `openship_server` backup_destination row into a row
 * the SFTP adapter can consume.
 *
 * Cleanly separates concerns: the adapter doesn't know about the
 * `servers` table; this module bridges between the user's saved
 * servers (used for deployments) and backup destinations.
 *
 * Credential strategy:
 *   - server.sshPassword is stored as enc1: ciphertext → pass through
 *     as sftpPasswordEnc.
 *   - server.sshKeyPath is a FILE PATH on the API host. Read the key
 *     contents (synchronously is fine — we're in an async function +
 *     the file is small) and re-wrap as enc1: ciphertext for the
 *     adapter to decrypt.
 *   - server.sshKeyPassphrase is enc1: → pass through.
 *
 * Path-traversal defense mirrors buildSshConfig: absolute path, no ".."
 * segments.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { repos, type BackupDestination } from "@repo/db";
import type { BackupDestinationRow } from "@repo/adapters";
import { encryptSecretField } from "../../lib/credential-encryption";
import { resolveSafeSshKeyPath } from "../../lib/ssh-key-path";
import { safeErrorMessage } from "@repo/core";
import { assertLocalDestinationAllowed } from "./local-gate";

/**
 * Take a raw backup_destination DB row and produce a BackupDestinationRow
 * suitable for `resolveDestination`. For most kinds this is a 1:1 mapping;
 * `openship_server` is the special case that needs server-table lookup.
 */
export async function toAdapterRow(row: BackupDestination): Promise<BackupDestinationRow> {
  // The consumer-side gate. Every path that USES a destination funnels through here
  // (a backup run, the retention prune, both restore phases), so this is the one
  // place that can speak for all of them — the create/update gate only ever
  // constrained rows that took the write path. See ./local-gate.ts.
  if (row.kind === "local") {
    await assertLocalDestinationAllowed(row.endpoint);
  }
  if (row.kind === "openship_server") {
    if (!row.serverId) {
      throw new Error(
        `Destination "${row.name}" is kind=openship_server but has no serverId — corrupted state`,
      );
    }
    return hydrateServerAdapterRow({
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      pathPrefix: row.pathPrefix,
      serverId: row.serverId,
    });
  }
  // All other kinds: straight pass-through of the row fields the
  // adapter expects.
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    kind: row.kind as BackupDestinationRow["kind"],
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    pathPrefix: row.pathPrefix,
    sshHost: row.sshHost,
    sshPort: row.sshPort,
    sshUser: row.sshUser,
    serverId: row.serverId,
    accessKeyIdEnc: row.accessKeyIdEnc,
    secretAccessKeyEnc: row.secretAccessKeyEnc,
    sftpPasswordEnc: row.sftpPasswordEnc,
    sftpPrivateKeyEnc: row.sftpPrivateKeyEnc,
    sftpKeyPassphraseEnc: row.sftpKeyPassphraseEnc,
  };
}

/**
 * Build an SFTP adapter row from an already-added server, given only the
 * destination's identity + remote path. Shared by the persisted-row path
 * (`toAdapterRow`) and the pre-save draft preflight (which has no DB row yet).
 */
export async function hydrateServerAdapterRow(params: {
  id: string;
  organizationId: string;
  name: string;
  pathPrefix: string | null;
  serverId: string;
}): Promise<BackupDestinationRow> {
  const { id, organizationId, name, pathPrefix, serverId } = params;
  // ORG-SCOPED: this function goes on to read the server's SSH password or private
  // KEY MATERIAL and hand it to the SFTP adapter. An unscoped lookup would let a
  // destination row whose serverId names another org's box borrow that box's
  // credentials — and `backup_destination` is organization-scope dumpable, so a row
  // can arrive by ingest without ever passing the create-time checks. A foreign id
  // must read as "no longer exists", which is also what a deleted one reads as.
  const server = await repos.server.getInOrganization(serverId, organizationId);
  if (!server) {
    throw new Error(
      `Server ${serverId} referenced by destination "${name}" no longer exists`,
    );
  }

  let sftpPasswordEnc: string | null = null;
  let sftpPrivateKeyEnc: string | null = null;
  let sftpKeyPassphraseEnc: string | null = null;

  if (server.sshAuthMethod === "password" && server.sshPassword) {
    sftpPasswordEnc = server.sshPassword;
  } else if (server.sshAuthMethod === "key" && (server.sshPrivateKey || server.sshKeyPath)) {
    if (server.sshPrivateKey) {
      // Pasted/uploaded material — already `enc1:`-encrypted at rest, so hand it
      // straight to the SFTP adapter (same passthrough as the password branch).
      // No host filesystem to read, so buildSshConfig's path allowlist is moot.
      sftpPrivateKeyEnc = server.sshPrivateKey;
    } else {
      // Key on THIS host's filesystem. Centralised allowlist + traversal check —
      // see lib/ssh-key-path.ts. homedir() is added as an extra root so an
      // operator's ~/.ssh/openship key works without explicit env configuration.
      let keyPath: string;
      try {
        keyPath = resolveSafeSshKeyPath(server.sshKeyPath!, {
          extraRoots: [homedir()],
        });
      } catch (err) {
        throw new Error(
          `Server ${server.id} sshKeyPath rejected: ${
            safeErrorMessage(err)
          }`,
        );
      }
      let keyMaterial: string;
      try {
        keyMaterial = await readFile(keyPath, "utf-8");
      } catch (err) {
        throw new Error(
          `Failed to read SSH key at ${keyPath} for server ${server.id}: ${
            safeErrorMessage(err)
          }`,
        );
      }
      sftpPrivateKeyEnc = encryptSecretField(keyMaterial);
    }
    if (server.sshKeyPassphrase) {
      sftpKeyPassphraseEnc = server.sshKeyPassphrase;
    }
  } else {
    throw new Error(
      `Server ${server.id} has no usable SSH credentials (auth method: ${server.sshAuthMethod ?? "(unset)"})`,
    );
  }

  return {
    id,
    organizationId,
    name,
    kind: "openship_server",
    endpoint: null,
    region: null,
    bucket: null,
    pathPrefix,
    sshHost: server.sshHost,
    sshPort: server.sshPort ?? 22,
    sshUser: server.sshUser ?? "root",
    serverId,
    accessKeyIdEnc: null,
    secretAccessKeyEnc: null,
    sftpPasswordEnc,
    sftpPrivateKeyEnc,
    sftpKeyPassphraseEnc,
  };
}
