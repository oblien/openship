import { verifyCustomerSshConnection } from "../../lib/customer-ssh";
import { createHash } from "node:crypto";
import { AppError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import type { MigrationSourceInput } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { sshManager } from "../../lib/ssh-manager";
import { encryptSecretField } from "../../lib/credential-encryption";
import { withServerInventoryLock } from "../../lib/server-inventory-lock";
import { serializeServer } from "../system/server-view";

function sourceView(server: NonNullable<Awaited<ReturnType<typeof repos.server.get>>>) {
  return { ...serializeServer(server)!, projectCount: 0, hostChannel: null };
}

const verifySource = (input: MigrationSourceInput) => verifyCustomerSshConnection(input, "migration_source");

export async function listMigrationSources(ctx: ExecutionContext) {
  const rows = await repos.server.listMigrationSources(ctx.organizationId);
  const visible = [];
  for (const row of rows) {
    if (await authorization.checkPermissionOnResource(ctx, { resourceType: "server", resourceId: row.id, action: "read" }))
      visible.push(sourceView(row));
  }
  return visible;
}

export async function testMigrationSource(input: MigrationSourceInput) {
  const { hostKey } = await verifySource(input);
  return { ok: true, message: "SSH connection verified", fingerprint: `SHA256:${createHash("sha256").update(Buffer.from(hostKey, "base64")).digest("base64").replace(/=+$/, "")}` };
}

export async function createMigrationSource(ctx: ExecutionContext, input: MigrationSourceInput) {
  const { settings, hostKey } = await verifySource(input);
  const server = await repos.server.create({
    ...settings,
    purpose: "migration_source",
    organizationId: ctx.organizationId,
    name: input.name?.trim() || null,
    sshHostKey: hostKey,
    sshPassword: encryptSecretField(settings.sshPassword),
    sshPrivateKey: encryptSecretField(settings.sshPrivateKey),
    sshKeyPassphrase: encryptSecretField(settings.sshKeyPassphrase),
  });
  await audit.record(operationAuditContext(ctx), { eventType: "migration.source_connected", resourceType: "server", resourceId: server.id });
  return sourceView(server);
}

export async function deleteMigrationSource(ctx: ExecutionContext, id: string) {
  await authorization.authorize(ctx, { resourceType: "server", resourceId: id, action: "write" });
  // Shares admission with begin: removal can never sever a live run's rollback path.
  await withServerInventoryLock(ctx.organizationId, async () => {
    const row = await repos.server.getInOrganization(id, ctx.organizationId);
    if (!row || row.purpose !== "migration_source") throw new NotFoundError("Migration source", id);
    if ((await repos.dockerMigrationRun.findActiveForServer(id)).length)
      throw new AppError("Finish or cancel this server's migration before disconnecting it", 409, "MIGRATION_SOURCE_BUSY");
    await sshManager.invalidate(id);
    await repos.server.delete(id);
  });
  await audit.record(operationAuditContext(ctx), { eventType: "migration.source_disconnected", resourceType: "server", resourceId: id });
}
