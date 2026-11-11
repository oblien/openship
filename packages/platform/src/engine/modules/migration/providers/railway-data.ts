import ssh2 from "ssh2";
import { z } from "zod";
import { repos } from "@repo/db";
import { AppError } from "@repo/core";
import { createExecutor, CommandSourceBackupExecutor } from "@repo/adapters";
import type { ProviderService } from "./types";
import { railwayQuery } from "../../credentials/provider-api";
import { getProviderAccess } from "../../credentials/connection-authorization";
import { encrypt, decrypt } from "../../../lib/encryption";
import { buildSshConfig } from "../../../lib/ssh-manager";
import { verifyCustomerSshConnection } from "../../../lib/customer-ssh";
import { nodes, parseProvider, nextCursor, MAX_DISCOVERY_PAGES } from "./common";
import type { ProviderAccess } from "../../credentials/provider-api";

async function ownedKey(access: ProviderAccess, publicKey: string) {
  let after: string | undefined;
  // Match key bytes, never a user-controlled name. Comments may be normalized by the provider.
  const identity = (value: string) => value.trim().split(/\s+/).slice(0, 2).join(" ");
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const result = parseProvider(
      z.object({ sshPublicKeys: nodes(z.object({ id: z.string(), publicKey: z.string() })) }),
      await railwayQuery(
        access,
        "query($workspace: String, $after: String) { sshPublicKeys(workspaceId: $workspace, first: 100, after: $after) { edges { node { id publicKey } } pageInfo { hasNextPage endCursor } } }",
        { workspace: access.publicFields.workspaceId ?? null, after: after ?? null },
      ),
    );
    const found = result.sshPublicKeys.edges.find(
      ({ node }) => identity(node.publicKey) === identity(publicKey),
    );
    if (found) return found.node.id;
    after = nextCursor(after, result.sshPublicKeys.pageInfo);
    if (!after) return undefined;
  }
  throw new AppError(
    "Railway key discovery was incomplete; cleanup will retry",
    502,
    "IMPORT_SSH_CLEANUP_REQUIRED",
  );
}

/** Each import owns one short-lived SSH grant. Revoke by its recorded provider
 * ID, including after an API restart; never touch the user's existing keys. */
export async function openRailwayDataSource(
  runId: string,
  source: ProviderService,
  signal: AbortSignal,
) {
  const run = await repos.dockerMigrationRun.findById(runId);
  let checkpoint = run?.recovery.providerImport;
  if (!run || !checkpoint || !source.instanceId)
    throw new AppError("The Railway data source is unavailable", 409, "IMPORT_DATA_UNAVAILABLE");
  const access = await getProviderAccess(run.organizationId, checkpoint.connectionId);
  if (!checkpoint.sshKeyId) {
    if (checkpoint.sshPrivateKeyEnc)
      throw new AppError(
        "An earlier SSH grant needs cleanup before starting another export",
        409,
        "IMPORT_SSH_CLEANUP_REQUIRED",
      );
    const key = ssh2.utils.generateKeyPairSync("ed25519", { comment: `openship-import-${runId}` });
    // Persist intent BEFORE the remote mutation. If its response or the following
    // DB write is lost, recovery finds exactly this public key and revokes it.
    checkpoint = {
      ...checkpoint,
      sshPrivateKeyEnc: encrypt(key.private),
      sshPublicKey: key.public,
      sshKeyRequestedAt: Date.now(),
    };
    await repos.dockerMigrationRun.updateRecovery(runId, { providerImport: checkpoint });
    const result = parseProvider(
      z.object({ sshPublicKeyCreate: z.object({ id: z.string().min(1).max(200) }) }),
      await railwayQuery(
        access,
        "mutation($input: SshPublicKeyCreateInput!) { sshPublicKeyCreate(input: $input) { id } }",
        {
          input: {
            name: `Openship import ${runId}`,
            publicKey: key.public,
            ...(access.publicFields.workspaceId
              ? { workspaceId: access.publicFields.workspaceId }
              : {}),
          },
        },
      ),
    );
    if (!result.sshPublicKeyCreate?.id)
      throw new AppError(
        "Railway did not grant SSH access for data export",
        502,
        "IMPORT_SSH_DENIED",
      );
    checkpoint = { ...checkpoint, sshKeyId: result.sshPublicKeyCreate.id };
    await repos.dockerMigrationRun.updateRecovery(runId, { providerImport: checkpoint });
  }
  if (!checkpoint.sshPrivateKeyEnc)
    throw new AppError(
      "The import's SSH key is unavailable. Revoke it and start another reviewed import.",
      409,
      "IMPORT_SSH_KEY_MISSING",
    );
  const settings = {
    sshHost: "ssh.railway.com",
    sshPort: 22,
    sshUser: source.instanceId,
    sshAuthMethod: "key" as const,
    sshPrivateKey: decrypt(checkpoint.sshPrivateKeyEnc),
  };
  const verified = await verifyCustomerSshConnection(
    settings,
    "migration_source",
    checkpoint.sshHostKey,
  );
  if (!checkpoint.sshHostKey) {
    checkpoint = { ...checkpoint, sshHostKey: verified.hostKey };
    await repos.dockerMigrationRun.updateRecovery(runId, { providerImport: checkpoint });
  }
  const config = await buildSshConfig({ ...settings, sshHostKey: checkpoint.sshHostKey });
  if (!config)
    throw new AppError(
      "The Railway data connection could not be prepared",
      502,
      "IMPORT_SSH_UNAVAILABLE",
    );
  const command = createExecutor(config);
  return {
    executor: new CommandSourceBackupExecutor(
      command,
      source.volumes.map((v) => v.mountPath),
      signal,
    ),
    dispose: () => command.dispose(),
  };
}

export async function revokeRailwayImportKey(runId: string) {
  const run = await repos.dockerMigrationRun.findById(runId);
  const checkpoint = run?.recovery.providerImport;
  if (!run || !checkpoint?.sshPrivateKeyEnc) return;
  const access = await getProviderAccess(run.organizationId, checkpoint.connectionId);
  if (!checkpoint.sshKeyId && Date.now() - (checkpoint.sshKeyRequestedAt ?? Date.now()) < 60_000)
    throw new AppError(
      "Waiting for the Railway grant request to settle before cleanup",
      409,
      "IMPORT_SSH_CLEANUP_REQUIRED",
    );
  const id = checkpoint.sshPublicKey
    ? await ownedKey(access, checkpoint.sshPublicKey)
    : checkpoint.sshKeyId;
  if (id) {
    const result = await railwayQuery<{ sshPublicKeyDelete: boolean }>(
      access,
      "mutation($id: String!) { sshPublicKeyDelete(id: $id) }",
      { id },
    );
    if (!result.sshPublicKeyDelete)
      throw new AppError(
        "Remove this import's temporary SSH key in Railway, then retry cleanup",
        409,
        "IMPORT_SSH_CLEANUP_REQUIRED",
      );
  }
  const {
    sshKeyId: _id,
    sshPrivateKeyEnc: _key,
    sshPublicKey: _public,
    sshKeyRequestedAt: _requested,
    ...clean
  } = checkpoint;
  await repos.dockerMigrationRun.updateRecovery(runId, { providerImport: clean });
}
