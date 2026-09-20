import { and, eq, inArray, isNull } from "drizzle-orm";
import { generateId, ValidationError } from "@repo/core";
import type { Database, DatabaseTransaction } from "../client";
import { projectConnection, project, envVar } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProjectConnection = typeof projectConnection.$inferSelect;
export type NewProjectConnection = typeof projectConnection.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createProjectConnectionRepo(db: Database | DatabaseTransaction) {
  return {
    /** Links a consumer (target) project depends on. */
    async listByTarget(targetProjectId: string): Promise<ProjectConnection[]> {
      return db.query.projectConnection.findMany({
        where: eq(projectConnection.targetProjectId, targetProjectId),
      });
    },

    /** Links that consume a given source DB app (e.g. to block its deletion). */
    async listBySource(sourceProjectId: string): Promise<ProjectConnection[]> {
      return db.query.projectConnection.findMany({
        where: eq(projectConnection.sourceProjectId, sourceProjectId),
      });
    },

    async listBySourceService(sourceServiceId: string): Promise<ProjectConnection[]> {
      return db.query.projectConnection.findMany({
        where: eq(projectConnection.sourceServiceId, sourceServiceId),
      });
    },

    async findById(id: string): Promise<ProjectConnection | undefined> {
      return db.query.projectConnection.findFirst({
        where: eq(projectConnection.id, id),
      });
    },

    /** Create or update the link for (target, envKey) — one env var, one source. */
    async upsert(
      data: Omit<NewProjectConnection, "id" | "createdAt" | "updatedAt"> & { id?: string },
    ): Promise<ProjectConnection> {
      const [row] = await db
        .insert(projectConnection)
        .values({ id: data.id ?? generateId("conn"), ...data })
        .onConflictDoUpdate({
          target: [projectConnection.targetProjectId, projectConnection.envKey],
          set: {
            organizationId: data.organizationId,
            sourceProjectId: data.sourceProjectId,
            sourceServiceId: data.sourceServiceId ?? null,
            outputId: data.outputId,
            mode: data.mode,
            usesPrivateNetwork: data.usesPrivateNetwork ?? true,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },

    /** A bundle owns its env keys and links together, including on reconnect. */
    async saveBindings(
      targetProjectId: string,
      environment: string,
      bindings: Array<{
        connection: Omit<NewProjectConnection, "id" | "createdAt" | "updatedAt">;
        encryptedValue: string;
      }>,
    ): Promise<ProjectConnection[]> {
      return db.transaction(async tx => {
        // Serialize changes to this consumer's bindings, including the ownership check.
        await tx.select({ id: project.id }).from(project).where(eq(project.id, targetProjectId)).for("update");
        const links = await tx.query.projectConnection.findMany({ where: eq(projectConnection.targetProjectId, targetProjectId) });
        const keys = bindings.map(binding => binding.connection.envKey);
        const scope = and(eq(envVar.projectId, targetProjectId), eq(envVar.environment, environment), isNull(envVar.serviceId), inArray(envVar.key, keys));
        const existingVars = await tx.select({ key: envVar.key }).from(envVar).where(scope);
        const owned = new Set(links.map(link => link.envKey));
        for (const variable of existingVars) {
          if (!owned.has(variable.key)) throw new ValidationError(`An environment variable "${variable.key}" already exists on this project. Choose another name or remove it before connecting.`);
        }
        await tx.delete(envVar).where(scope);
        await tx.insert(envVar).values(bindings.map(binding => ({
          id: generateId("env"), projectId: targetProjectId, environment, serviceId: null,
          key: binding.connection.envKey, value: binding.encryptedValue, isSecret: true,
        })));
        const repo = createProjectConnectionRepo(tx);
        const result: ProjectConnection[] = [];
        for (const binding of bindings) result.push(await repo.upsert(binding.connection));
        return result;
      });
    },

    async delete(id: string): Promise<void> {
      await db.delete(projectConnection).where(eq(projectConnection.id, id));
    },

    /** Guard for a scoped delete: only within the given target project. */
    async findInTarget(
      id: string,
      targetProjectId: string,
    ): Promise<ProjectConnection | undefined> {
      return db.query.projectConnection.findFirst({
        where: and(
          eq(projectConnection.id, id),
          eq(projectConnection.targetProjectId, targetProjectId),
        ),
      });
    },
  };
}
