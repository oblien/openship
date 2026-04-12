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

    /** Return the primary domain for a project (or first domain, or null). */
    async getPrimaryByProject(projectId: string): Promise<Domain | null> {
      const rows = await db.query.domain.findMany({
        where: eq(domain.projectId, projectId),
      });
      return rows.find((d) => d.isPrimary) ?? rows[0] ?? null;
    },

    async create(data: Omit<NewDomain, "id"> & { verificationToken?: string }) {
      const id = generateId("dom");
      const row = {
        id,
        ...data,
        hostname: data.hostname.toLowerCase(),
        verificationToken: data.verificationToken ?? id,
      };
      await db.insert(domain).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as Domain;
    },

    /**
     * Return an existing domain by hostname, or create it if missing.
     * Safe against unique-constraint races (concurrent deploys).
     */
    async findOrCreate(data: Omit<NewDomain, "id"> & { verificationToken?: string }) {
      const hostname = data.hostname.toLowerCase();
      const existing = await db.query.domain.findFirst({
        where: eq(domain.hostname, hostname),
      });
      if (existing) {
        // Promote to primary if caller wants it and it isn't already
        if (data.isPrimary && !existing.isPrimary) {
          await db.update(domain)
            .set({ isPrimary: true, updatedAt: new Date() })
            .where(eq(domain.id, existing.id));
          return { ...existing, isPrimary: true };
        }
        return existing;
      }

      const id = generateId("dom");
      const row = {
        id,
        ...data,
        hostname,
        verificationToken: data.verificationToken ?? id,
      };
      try {
        await db.insert(domain).values(row);
        return { ...row, createdAt: new Date(), updatedAt: new Date() } as Domain;
      } catch (err: any) {
        // Handle race: another deploy inserted between our check and insert
        if (err?.message?.includes("unique") || err?.code === "23505") {
          const raced = await db.query.domain.findFirst({
            where: eq(domain.hostname, hostname),
          });
          if (raced) return raced;
        }
        throw err;
      }
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
