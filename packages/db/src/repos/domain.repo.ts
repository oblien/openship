import { eq, and, lt } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { domain } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Domain = typeof domain.$inferSelect;
export type NewDomain = typeof domain.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createDomainRepo(db: Database) {
  return {
    async findById(id: string) {
      return db.query.domain.findFirst({
        where: eq(domain.id, id),
      });
    },

    async findByHostname(hostname: string) {
      return db.query.domain.findFirst({
        where: eq(domain.hostname, hostname.toLowerCase()),
      });
    },

    async listByProject(projectId: string) {
      return db.query.domain.findMany({
        where: eq(domain.projectId, projectId),
      });
    },

    async create(data: Omit<NewDomain, "id">) {
      const id = generateId("dom");
      const token = `openship-verify=${generateId()}`;
      const row = {
        id,
        ...data,
        hostname: data.hostname.toLowerCase(),
        verificationToken: token,
      };
      await db.insert(domain).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as Domain;
    },

    async markVerified(id: string) {
      await db
        .update(domain)
        .set({
          verified: true,
          verifiedAt: new Date(),
          status: "active",
          updatedAt: new Date(),
        })
        .where(eq(domain.id, id));
    },

    async updateSsl(
      id: string,
      data: { sslStatus: string; sslIssuer?: string; sslExpiresAt?: Date },
    ) {
      await db
        .update(domain)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(domain.id, id));
    },

    async updateStatus(id: string, status: string) {
      await db
        .update(domain)
        .set({ status, updatedAt: new Date() })
        .where(eq(domain.id, id));
    },

    async remove(id: string) {
      await db.delete(domain).where(eq(domain.id, id));
    },

    /** Find all domains needing SSL renewal */
    async findExpiringSsl(beforeDate: Date) {
      return db.query.domain.findMany({
        where: and(
          eq(domain.sslStatus, "active"),
          lt(domain.sslExpiresAt, beforeDate),
        ),
      });
    },

    /** Set primary domain for a project (unsets previous primary) */
    async setPrimary(projectId: string, domainId: string) {
      // Unset current primary
      await db
        .update(domain)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(and(eq(domain.projectId, projectId), eq(domain.isPrimary, true)));
      // Set new primary
      await db
        .update(domain)
        .set({ isPrimary: true, updatedAt: new Date() })
        .where(eq(domain.id, domainId));
    },
  };
}
