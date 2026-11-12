import { eq, and, inArray, or, ne, isNull, sql } from "drizzle-orm";
import { generateId, AppError, EDGE_RESPONSE_MAX_ROUTES } from "@repo/core";
import type { Database } from "../client";
import { project, routeRule } from "../schema";
import { withProjectConfigurationWrite } from "./project-work-admission";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RouteRule = typeof routeRule.$inferSelect;
export type NewRouteRule = typeof routeRule.$inferInsert;

/** The project write lock also makes duplicate-path checks safe under concurrent saves. */
async function assertResponseSlot(db: Pick<Database, "select">, data: NewRouteRule, ignoreId?: string) {
  const response = data.spec?.response;
  if (!response) return;
  const responses = await db.select({
    pathPrefix: routeRule.pathPrefix,
    match: sql<string>`coalesce(${routeRule.spec}->'response'->>'match', 'exact')`,
  }).from(routeRule).where(and(
    eq(routeRule.projectId, data.projectId),
    data.domainId ? eq(routeRule.domainId, data.domainId) : isNull(routeRule.domainId),
    sql`${routeRule.spec}->'response' is not null`,
    ignoreId ? ne(routeRule.id, ignoreId) : undefined,
  )).limit(EDGE_RESPONSE_MAX_ROUTES);
  const duplicate = responses.some((existing) =>
    (existing.pathPrefix || "/") === (data.pathPrefix || "/") && existing.match === response.match);
  if (duplicate) throw new AppError("A static response already exists for this domain, path, and match type. Edit the existing route.", 409, "EDGE_RESPONSE_EXISTS");
  if (responses.length >= EDGE_RESPONSE_MAX_ROUTES)
    throw new AppError("A domain can have at most 64 static responses. Remove a route before adding another.", 409, "EDGE_RESPONSE_LIMIT");
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createRouteRuleRepo(db: Database) {
  const ownerPredicate = (id: string) => inArray(project.id,
    db.select({ id: routeRule.projectId }).from(routeRule).where(eq(routeRule.id, id)));
  return {
    async get(id: string) {
      return db.query.routeRule.findFirst({ where: eq(routeRule.id, id) });
    },

    /** Every rule for a project — the routing push serializes them all. */
    async listByProject(projectId: string): Promise<RouteRule[]> {
      return db.query.routeRule.findMany({
        where: eq(routeRule.projectId, projectId),
      });
    },

    async listByDomain(domainId: string): Promise<RouteRule[]> {
      return db.query.routeRule.findMany({
        where: eq(routeRule.domainId, domainId),
      });
    },

    async create(data: Omit<NewRouteRule, "id">): Promise<RouteRule> {
      const id = generateId("rr");
      const row = { id, ...data };
      await withProjectConfigurationWrite(db, eq(project.id, data.projectId), async (tx) => {
        await assertResponseSlot(tx, row);
        await tx.insert(routeRule).values(row);
      });
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as RouteRule;
    },

    async update(id: string, data: Partial<NewRouteRule>) {
      const predicate = or(ownerPredicate(id), data.projectId ? eq(project.id, data.projectId) : undefined)!;
      await withProjectConfigurationWrite(db, predicate, async (tx) => {
        const [existing] = await tx.select().from(routeRule).where(eq(routeRule.id, id)).limit(1);
        if (existing) await assertResponseSlot(tx, { ...existing, ...data }, id);
        await tx.update(routeRule).set({ ...data, updatedAt: new Date() }).where(eq(routeRule.id, id));
      });
    },

    async remove(id: string) {
      await withProjectConfigurationWrite(db, ownerPredicate(id), async (tx) => tx.delete(routeRule).where(eq(routeRule.id, id)));
    },

    /** Scoped delete — guards a mutation to a project's own rule. */
    async removeForProject(projectId: string, id: string) {
      await withProjectConfigurationWrite(db, eq(project.id, projectId), async (tx) => tx
        .delete(routeRule)
        .where(and(eq(routeRule.projectId, projectId), eq(routeRule.id, id))));
    },

    async deleteByProjectId(projectId: string) {
      await withProjectConfigurationWrite(db, eq(project.id, projectId), async (tx) => tx.delete(routeRule).where(eq(routeRule.projectId, projectId)));
    },
  };
}
