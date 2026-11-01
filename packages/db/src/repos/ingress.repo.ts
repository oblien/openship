import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import { assertProjectConfigurationWritable } from "./project-work-admission";
import { ConflictError } from "@repo/core";
import type { Database } from "../connection";
import { ingressConnection, ingressHostname, domain, project } from "../schema";
export type IngressConnection = typeof ingressConnection.$inferSelect;
export type IngressHostname = typeof ingressHostname.$inferSelect;
export function createIngressRepo(db: Database) {
  return {
    list: (organizationId: string, serverId?: string) =>
      db
        .select()
        .from(ingressConnection)
        .where(
          and(
            eq(ingressConnection.organizationId, organizationId),
            serverId ? eq(ingressConnection.serverId, serverId) : undefined,
          ),
        ),
    async get(organizationId: string, id: string) {
      return (
        await db
          .select()
          .from(ingressConnection)
          .where(
            and(eq(ingressConnection.id, id), eq(ingressConnection.organizationId, organizationId)),
          )
          .limit(1)
      )[0];
    },
    async byServer(serverId: string) {
      return (
        await db
          .select()
          .from(ingressConnection)
          .where(eq(ingressConnection.serverId, serverId))
          .limit(1)
      )[0];
    },
    async create(values: typeof ingressConnection.$inferInsert) {
      try {
        return (await db.insert(ingressConnection).values(values).returning())[0];
      } catch (error) {
        const e = error as { code?: string; cause?: { code?: string } };
        if (e.code === "23505" || e.cause?.code === "23505")
          throw new ConflictError(
            "This server or Cloudflare tunnel already has an ingress connection. Disconnect it before connecting another.",
          );
        throw error;
      }
    },
    async update(
      id: string,
      patch: Partial<
        Omit<IngressConnection, "id" | "organizationId" | "serverId" | "credentialId" | "accountId">
      >,
    ) {
      return (
        await db
          .update(ingressConnection)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(ingressConnection.id, id))
          .returning()
      )[0];
    },
    async remove(id: string) {
      await db.delete(ingressConnection).where(eq(ingressConnection.id, id));
    },
    async listForHost(hostId: string) {
      return (
        await db
          .select({ connection: ingressConnection })
          .from(ingressConnection)
          .innerJoin(ingressHostname, eq(ingressHostname.connectionId, ingressConnection.id))
          .where(eq(ingressHostname.id, hostId))
          .limit(1)
      )[0]?.connection;
    },
    async bindDomain(domainId: string, connectionId: string, accessPolicyId: string | null) {
      return db.transaction(async (tx) => {
        const [d] = await tx.select().from(domain).where(eq(domain.id, domainId));
        if (!d?.projectId) throw new ConflictError("This domain does not belong to a project.");
        await assertProjectConfigurationWritable(tx, eq(project.id, d.projectId));
        const [c] = await tx
          .select()
          .from(ingressConnection)
          .where(eq(ingressConnection.id, connectionId))
          .for("update");
        const [p] = await tx.select().from(project).where(eq(project.id, d.projectId));
        if (
          !c ||
          c.status === "removing" ||
          c.serverId !== p?.serverId ||
          c.organizationId !== p.organizationId
        )
          throw new ConflictError(
            "This tunnel does not belong to the project's deployment server.",
          );
        const [existing] = await tx
          .select()
          .from(ingressHostname)
          .where(eq(ingressHostname.domainId, domainId));
        if (existing && (existing.connectionId !== connectionId || existing.status === "removing"))
          throw new ConflictError("Wait for the previous hostname connection to finish removing.");
        await tx
          .update(domain)
          .set({ externalIngress: true, updatedAt: new Date() })
          .where(eq(domain.id, domainId));
        return (
          await tx
            .insert(ingressHostname)
            .values({
              id: generateId("igh"),
              domainId,
              connectionId,
              hostname: d.hostname,
              accessPolicyId,
            })
            .onConflictDoUpdate({
              target: ingressHostname.domainId,
              set: {
                accessPolicyId,
                status: "pending",
                error: null,
                nextAttemptAt: new Date(),
                updatedAt: new Date(),
              },
            })
            .returning()
        )[0];
      });
    },
    hosts: (connectionId: string) =>
      db.select().from(ingressHostname).where(eq(ingressHostname.connectionId, connectionId)),
    async host(id: string) {
      return (
        await db.select().from(ingressHostname).where(eq(ingressHostname.id, id)).limit(1)
      )[0];
    },
    async forDomain(domainId: string) {
      return (
        await db
          .select()
          .from(ingressHostname)
          .where(eq(ingressHostname.domainId, domainId))
          .limit(1)
      )[0];
    },
    async bind(values: Omit<typeof ingressHostname.$inferInsert, "id">) {
      return (
        await db
          .insert(ingressHostname)
          .values({ id: generateId("igh"), ...values })
          .returning()
      )[0];
    },
    async updateHost(
      id: string,
      patch: Partial<Omit<IngressHostname, "id" | "connectionId" | "hostname">>,
    ) {
      return (
        await db
          .update(ingressHostname)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(ingressHostname.id, id))
          .returning()
      )[0];
    },
    async completeHostname(id: string, domainId: string) {
      await db.transaction(async (tx) => {
        const [host] = await tx
          .select()
          .from(ingressHostname)
          .where(and(eq(ingressHostname.id, id), eq(ingressHostname.domainId, domainId)));
        const [d] = await tx.select().from(domain).where(eq(domain.id, domainId));
        if (!host || !d?.projectId)
          throw new ConflictError("This managed hostname changed during setup.");
        await assertProjectConfigurationWritable(tx, eq(project.id, d.projectId));
        const [c] = await tx
          .select()
          .from(ingressConnection)
          .where(eq(ingressConnection.id, host.connectionId))
          .for("update");
        if (!c || c.status !== "ready")
          throw new ConflictError("The tunnel connection changed during hostname setup.");
        const now = new Date();
        await tx
          .update(domain)
          .set({
            verified: true,
            verifiedAt: now,
            status: "active",
            verifyAttempts: 0,
            lastVerifyError: null,
            lastCheckedAt: now,
            sslStatus: "external",
            sslIssuer: "cloudflare",
            updatedAt: now,
          })
          .where(eq(domain.id, domainId));
        await tx
          .update(ingressHostname)
          .set({
            status: "ready",
            phase: "ready",
            error: null,
            attempts: 0,
            nextAttemptAt: new Date(Date.now() + 15 * 60_000),
            updatedAt: now,
          })
          .where(eq(ingressHostname.id, id));
      });
    },
    async removeHost(id: string) {
      await db.delete(ingressHostname).where(eq(ingressHostname.id, id));
    },
    /** Index-bounded work queue. Orphaned domain FKs are cleanup tombstones. Ready
     * rows get a slow drift check, never one provider poll per page request. */
    due: (limit = 20) =>
      db
        .select({ host: ingressHostname, connection: ingressConnection })
        .from(ingressHostname)
        .innerJoin(ingressConnection, eq(ingressHostname.connectionId, ingressConnection.id))
        .where(
          or(
            and(isNull(ingressHostname.domainId), eq(ingressHostname.status, "ready")),
            lte(ingressHostname.nextAttemptAt, new Date()),
          ),
        )
        .orderBy(
          sql`case when (${ingressHostname.domainId} is null and ${ingressHostname.status} = 'ready') or ${ingressHostname.status} = 'removing' then 0 when ${ingressHostname.status} = 'ready' then 2 else 1 end`,
          ingressHostname.nextAttemptAt,
        )
        .limit(limit),
    pendingConnections: () =>
      db
        .select()
        .from(ingressConnection)
        .where(
          and(
            or(
              eq(ingressConnection.status, "pending"),
              eq(ingressConnection.status, "error"),
              eq(ingressConnection.status, "removing"),
            ),
            lte(ingressConnection.nextAttemptAt, new Date()),
          ),
        )
        .orderBy(ingressConnection.nextAttemptAt)
        .limit(10),
  };
}
