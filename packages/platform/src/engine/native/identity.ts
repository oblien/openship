import { createHash } from "node:crypto";
import { db, repos, schema, and, eq, sql, getDriver } from "@repo/db";
import { AppError, ConflictError, NotFoundError, ValidationError, generateId } from "@repo/core";
import { provisionUserInTransaction } from "../lib/provision-user";
import { audit } from "../lib/audit-emitter";
import { changeMembership } from "../lib/member-lifecycle";
import type { ExternalIdentityInput, ExternalIdentityResult, NativeOperator } from "../../native-config";

function key(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x1f]/.test(value))
    throw new ValidationError(`${label} must be a nonempty string of at most 512 characters`);
  return value;
}

const identityWhere = (issuer: string, subject: string) => and(eq(schema.externalIdentity.issuer, issuer), eq(schema.externalIdentity.subject, subject));

export async function resolveExternalIdentity(input: { issuer: string; subject: string }): Promise<ExternalIdentityResult | null> {
  const issuer = key(input.issuer, "issuer"), subject = key(input.subject, "subject");
  const [mapped] = await db.select().from(schema.externalIdentity).where(identityWhere(issuer, subject));
  if (!mapped) return null;
  const user = await repos.user.findById(mapped.userId);
  return user ? { user: { id: user.id, name: user.name, email: user.email }, personalOrganizationId: `org_${user.id}` } : null;
}

export async function ensureExternalIdentity(input: ExternalIdentityInput): Promise<ExternalIdentityResult> {
  const issuer = key(input.issuer, "issuer"), subject = key(input.subject, "subject");
  if (typeof input.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254)
    throw new ValidationError("A valid identity email is required");
  if (input.name !== undefined) key(input.name, "name");
  await db.transaction(async tx => {
    // Stable lock identity prevents two provisions of the same assertion from creating orphan users.
    if (getDriver() === "pg") await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${JSON.stringify([issuer, subject])}))`);
    const [mapped] = await tx.select().from(schema.externalIdentity).where(identityWhere(issuer, subject));
    if (mapped) {
      if (input.userId && mapped.userId !== input.userId) throw new ConflictError("This external identity is already linked to another user");
      return;
    }
    const userId = input.userId ? key(input.userId, "userId") : generateId("usr");
    if (input.userId) {
      const [existing] = await tx.select().from(schema.user).where(eq(schema.user.id, userId));
      if (!existing) throw new NotFoundError("User", userId);
      // Linking never upgrades an existing user's instance role.
    } else {
      const [sameEmail] = await tx.select().from(schema.user).where(eq(schema.user.email, input.email));
      if (sameEmail) throw new ConflictError("That email already belongs to an account. Link its userId explicitly through the host operator.");
      await provisionUserInTransaction(tx, {
        id: userId, email: input.email, name: input.name,
        role: input.instanceAdmin === true ? "admin" : "user",
      });
    }
    await tx.insert(schema.externalIdentity).values({ issuer, subject, userId });
  });
  const result = await resolveExternalIdentity({ issuer, subject });
  if (!result) throw new AppError("Identity provisioning did not complete", 500, "IDENTITY_PROVISION_FAILED");
  await audit.record({ organizationId: result.personalOrganizationId, source: "system" }, {
    eventType: "identity.provisioned", resourceType: "user", resourceId: result.user.id,
    after: { issuer, subject },
  });
  return result;
}

export const ensureExternalNamespace: NativeOperator["ensureNamespace"] = async input => {
  const issuer = key(input.issuer, "issuer"), namespace = key(input.key, "key"), name = key(input.name, "name");
  const ownerUserId = key(input.ownerUserId, "ownerUserId");
  return db.transaction(async tx => {
    if (getDriver() === "pg") await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${JSON.stringify(["namespace", issuer, namespace])}))`);
    const [existing] = await tx.select().from(schema.externalNamespace).where(and(eq(schema.externalNamespace.issuer, issuer), eq(schema.externalNamespace.key, namespace)));
    if (existing) return { organizationId: existing.organizationId };
    const [owner] = await tx.select().from(schema.user).where(eq(schema.user.id, ownerUserId));
    if (!owner) throw new NotFoundError("User", ownerUserId);
    const organizationId = generateId("org");
    await tx.insert(schema.organization).values({ id: organizationId, name, slug: organizationId });
    await tx.insert(schema.member).values({ id: generateId("mem"), userId: ownerUserId, organizationId, role: "owner" });
    await tx.insert(schema.externalNamespace).values({ issuer, key: namespace, organizationId });
    return { organizationId };
  });
};

export const setNativeMembership: NativeOperator["setMembership"] = async input => {
  const organizationId = key(input.organizationId, "organizationId"), userId = key(input.userId, "userId");
  if (input.role !== null && !["owner", "admin", "member", "restricted"].includes(input.role)) throw new ValidationError("Invalid membership role");
  await db.transaction(async tx => {
    const [organization] = await tx.select().from(schema.organization).where(eq(schema.organization.id, organizationId)).for("update");
    if (!organization) throw new NotFoundError("Organization", organizationId);
    await changeMembership(tx, organizationId, userId, input.role);
  });
  await audit.record({ organizationId, source: "system" }, { eventType: "member.updated", resourceType: "user", resourceId: userId, after: { role: input.role } });
};

export async function bindInstallation(instanceId: string, encryptionKey: string): Promise<void> {
  const keyFingerprint = createHash("sha256").update("openship:installation-key:v1\0").update(encryptionKey).digest("hex");
  await db.insert(schema.platformInstance).values({ id: "primary", instanceId, keyFingerprint }).onConflictDoNothing();
  const [current] = await db.select().from(schema.platformInstance).where(eq(schema.platformInstance.id, "primary"));
  if (current?.instanceId !== instanceId || current.keyFingerprint !== keyFingerprint)
    throw new AppError("The database belongs to a different installation or encryption key", 409, "INSTALLATION_MISMATCH");
}
