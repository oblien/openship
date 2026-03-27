import { eq, and, asc } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { service, serviceDeployment } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Service = typeof service.$inferSelect;
export type NewService = typeof service.$inferInsert;
export type ServiceDeployment = typeof serviceDeployment.$inferSelect;
export type NewServiceDeployment = typeof serviceDeployment.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createServiceRepo(db: Database) {
  return {
    // ── Services ───────────────────────────────────────────────────────

    async findById(id: string) {
      return db.query.service.findFirst({
        where: eq(service.id, id),
      });
    },

    async findByName(projectId: string, name: string) {
      return db.query.service.findFirst({
        where: and(eq(service.projectId, projectId), eq(service.name, name)),
      });
    },

    async listByProject(projectId: string) {
      return db.query.service.findMany({
        where: eq(service.projectId, projectId),
        orderBy: [asc(service.sortOrder), asc(service.name)],
      });
    },

    async create(data: Omit<NewService, "id">) {
      const id = generateId("svc");
      const row = { id, ...data };
      await db.insert(service).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as Service;
    },

    async update(id: string, data: Partial<NewService>) {
      await db
        .update(service)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(service.id, id));
    },

    async remove(id: string) {
      await db.delete(service).where(eq(service.id, id));
    },

    /** Sync services from a parsed compose file. Creates new, updates existing, removes stale. */
    async syncFromCompose(
      projectId: string,
      parsed: {
        name: string;
        image?: string;
        build?: string;
        dockerfile?: string;
        ports?: string[];
        dependsOn?: string[];
        environment?: Record<string, string>;
        volumes?: string[];
        command?: string;
        restart?: string;
      }[],
    ) {
      const existing = await this.listByProject(projectId);
      const existingByName = new Map(existing.map((s) => [s.name, s]));
      const incomingNames = new Set(parsed.map((s) => s.name));

      // Create or update
      const results: Service[] = [];
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i];
        const ex = existingByName.get(p.name);

        if (ex) {
          // Update existing
          await this.update(ex.id, {
            image: p.image ?? null,
            build: p.build ?? null,
            dockerfile: p.dockerfile ?? null,
            ports: p.ports ?? [],
            dependsOn: p.dependsOn ?? [],
            environment: p.environment ?? {},
            volumes: p.volumes ?? [],
            command: p.command ?? null,
            restart: p.restart ?? "unless-stopped",
            enabled: true,
            sortOrder: i,
          });
          results.push({ ...ex, ...p, enabled: true, sortOrder: i, updatedAt: new Date() } as Service);
        } else {
          // Create new
          const svc = await this.create({
            projectId,
            name: p.name,
            image: p.image ?? null,
            build: p.build ?? null,
            dockerfile: p.dockerfile ?? null,
            ports: p.ports ?? [],
            dependsOn: p.dependsOn ?? [],
            environment: p.environment ?? {},
            volumes: p.volumes ?? [],
            command: p.command ?? null,
            restart: p.restart ?? "unless-stopped",
            enabled: true,
            sortOrder: i,
          });
          results.push(svc);
        }
      }

      // Remove stale services (not in the incoming compose)
      for (const ex of existing) {
        if (!incomingNames.has(ex.name)) {
          await this.remove(ex.id);
        }
      }

      return results;
    },

    // ── Service Deployments ────────────────────────────────────────────

    async findServiceDeployment(id: string) {
      return db.query.serviceDeployment.findFirst({
        where: eq(serviceDeployment.id, id),
      });
    },

    async listByDeployment(deploymentId: string) {
      return db.query.serviceDeployment.findMany({
        where: eq(serviceDeployment.deploymentId, deploymentId),
      });
    },

    async listByService(serviceId: string) {
      return db.query.serviceDeployment.findMany({
        where: eq(serviceDeployment.serviceId, serviceId),
      });
    },

    async createServiceDeployment(data: Omit<NewServiceDeployment, "id">) {
      const id = generateId("sd");
      const row = { id, ...data };
      await db.insert(serviceDeployment).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as ServiceDeployment;
    },

    async updateServiceDeployment(id: string, data: Partial<NewServiceDeployment>) {
      await db
        .update(serviceDeployment)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(serviceDeployment.id, id));
    },
  };
}
