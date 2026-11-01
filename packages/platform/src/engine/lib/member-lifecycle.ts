import { ConflictError, NotFoundError, generateId } from "@repo/core";
import { and, eq, schema, type DatabaseTransaction } from "@repo/db";
import { createResourceGrantRepo } from "@repo/db/repos";
import type { ContextRole } from "../../context";

/** Authorized callers hold the organization row lock. Shared by host membership
 * synchronization and ordinary membership operations, including cleanup. */
export async function changeMembership(tx: DatabaseTransaction, organizationId: string, userId: string, role: ContextRole | null) {
  const members = await tx.select().from(schema.member).where(eq(schema.member.organizationId, organizationId));
  const existing = members.find(member => member.userId === userId);
  if (existing?.role === "owner" && role !== "owner" && members.filter(member => member.role === "owner").length <= 1)
    throw new ConflictError("An organization must retain an owner");
  if (role === null) {
    await tx.delete(schema.member).where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)));
    await createResourceGrantRepo(tx).deleteByMember(organizationId, userId);
    await tx.delete(schema.notificationSubscription).where(and(eq(schema.notificationSubscription.organizationId, organizationId), eq(schema.notificationSubscription.userId, userId)));
    return existing ?? null;
  }
  const [user] = await tx.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId));
  if (!user) throw new NotFoundError("User", userId);
  const [member] = await tx.insert(schema.member).values({ id: generateId("mem"), userId, organizationId, role })
    .onConflictDoUpdate({ target: [schema.member.organizationId, schema.member.userId], set: { role } }).returning();
  return member!;
}
