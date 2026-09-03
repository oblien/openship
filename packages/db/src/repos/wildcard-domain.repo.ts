import { eq, desc } from "drizzle-orm";
import type { Database } from "../client";
import { wildcardDomain, type WildcardDomain, type NewWildcardDomain } from "../schema";
export type { WildcardDomain, NewWildcardDomain };

export function createWildcardDomainRepo(db: Database) {
  return {
    async list(): Promise<WildcardDomain[]> {
      return db.query.wildcardDomain.findMany({
        orderBy: [desc(wildcardDomain.isDefault), desc(wildcardDomain.createdAt)],
      });
    },

    async findById(id: string): Promise<WildcardDomain | undefined> {
      return db.query.wildcardDomain.findFirst({
        where: eq(wildcardDomain.id, id),
      });
    },

    async findByDefault(): Promise<WildcardDomain | undefined> {
      return db.query.wildcardDomain.findFirst({
        where: eq(wildcardDomain.isDefault, true),
      });
    },

    async findByDomain(domain: string): Promise<WildcardDomain | undefined> {
      return db.query.wildcardDomain.findFirst({
        where: eq(wildcardDomain.domain, domain.toLowerCase()),
      });
    },

    async create(data: NewWildcardDomain): Promise<WildcardDomain> {
      if (data.isDefault) {
        await db.update(wildcardDomain).set({ isDefault: false });
      }
      const [row] = await db.insert(wildcardDomain).values(data).returning();
      return row;
    },

    async setDefault(id: string): Promise<WildcardDomain | undefined> {
      await db.update(wildcardDomain).set({ isDefault: false });
      const [row] = await db
        .update(wildcardDomain)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(wildcardDomain.id, id))
        .returning();
      return row;
    },

    async update(id: string, data: Partial<NewWildcardDomain>): Promise<WildcardDomain | undefined> {
      const [row] = await db
        .update(wildcardDomain)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(wildcardDomain.id, id))
        .returning();
      return row;
    },

    async delete(id: string): Promise<void> {
      await db.delete(wildcardDomain).where(eq(wildcardDomain.id, id));
    },
  };
}
