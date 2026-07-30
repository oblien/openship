import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createProjectRepo } from "./project.repo";
import { createDeploymentRepo } from "./deployment.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Real (in-memory PGlite) tests for the dashboard-stats aggregates:
 * project.countByOrganization + deployment.countByStatusForOrganization.
 * These replaced the walk-projects-and-count-in-JS path that capped at 50
 * projects / 100 deployments each, so the interesting cases are exactly the
 * ones past those old caps. FK enforcement is disabled so we can seed
 * project/deployment rows without parent org/group rows.
 */
async function freshDb() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;"); // skip FK seeding
  return {
    db,
    projectRepo: createProjectRepo(db),
    deploymentRepo: createDeploymentRepo(db),
  };
}

type Db = Awaited<ReturnType<typeof freshDb>>["db"];

async function seedProject(
  db: Db,
  id: string,
  organizationId: string,
  opts?: { activeDeploymentId?: string; deletedAt?: Date },
) {
  await db.insert(schema.project).values({
    id,
    organizationId,
    groupId: `app_${id}`,
    name: id,
    slug: id,
    activeDeploymentId: opts?.activeDeploymentId ?? null,
    deletedAt: opts?.deletedAt ?? null,
  });
}

async function seedDeployments(
  db: Db,
  projectId: string,
  organizationId: string,
  statuses: string[],
) {
  await db.insert(schema.deployment).values(
    statuses.map((status, i) => ({
      id: `dep_${projectId}_${i}`,
      projectId,
      organizationId,
      branch: "main",
      status,
    })),
  );
}

describe("dashboard stats aggregates", () => {
  let db: Db;
  let projectRepo: ReturnType<typeof createProjectRepo>;
  let deploymentRepo: ReturnType<typeof createDeploymentRepo>;

  beforeEach(async () => {
    ({ db, projectRepo, deploymentRepo } = await freshDb());
  }, 30_000);

  it("counts deployments across more than 50 projects (old cap)", async () => {
    for (let i = 0; i < 60; i++) {
      await seedProject(db, `proj_${i}`, "org_1");
      await seedDeployments(db, `proj_${i}`, "org_1", ["ready"]);
    }
    const counts = await deploymentRepo.countByStatusForOrganization("org_1");
    expect(counts).toEqual({ ready: 60 });
  });

  it("counts more than 100 deployments in one project (old cap)", async () => {
    await seedProject(db, "proj_big", "org_1");
    // Terminal statuses only — the uq_deployment_one_active_per_project
    // partial index allows at most one queued/building/deploying per project.
    const statuses = [
      ...Array<string>(70).fill("ready"),
      ...Array<string>(40).fill("failed"),
      ...Array<string>(10).fill("cancelled"),
    ];
    await seedDeployments(db, "proj_big", "org_1", statuses);
    const counts = await deploymentRepo.countByStatusForOrganization("org_1");
    expect(counts).toEqual({ ready: 70, failed: 40, cancelled: 10 });
  });

  it("groups by status and never double-counts a deployment", async () => {
    await seedProject(db, "proj_a", "org_1");
    await seedProject(db, "proj_b", "org_1");
    await seedDeployments(db, "proj_a", "org_1", ["ready", "failed", "building"]);
    await seedDeployments(db, "proj_b", "org_1", ["ready", "cancelled"]);
    const counts = await deploymentRepo.countByStatusForOrganization("org_1");
    expect(counts).toEqual({ ready: 2, failed: 1, building: 1, cancelled: 1 });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(5);
  });

  it("excludes soft-deleted projects and other orgs from deployment counts", async () => {
    await seedProject(db, "proj_live", "org_1");
    await seedProject(db, "proj_gone", "org_1", { deletedAt: new Date() });
    await seedProject(db, "proj_other", "org_2");
    await seedDeployments(db, "proj_live", "org_1", ["ready"]);
    await seedDeployments(db, "proj_gone", "org_1", ["ready", "failed"]);
    await seedDeployments(db, "proj_other", "org_2", ["ready"]);
    expect(await deploymentRepo.countByStatusForOrganization("org_1")).toEqual({ ready: 1 });
  });

  it("returns an empty record for an org with no deployments", async () => {
    await seedProject(db, "proj_idle", "org_1");
    expect(await deploymentRepo.countByStatusForOrganization("org_1")).toEqual({});
  });

  it("counts total and active projects, ignoring soft-deleted and other orgs", async () => {
    await seedProject(db, "proj_active", "org_1", { activeDeploymentId: "dep_x" });
    await seedProject(db, "proj_inactive", "org_1");
    await seedProject(db, "proj_gone", "org_1", {
      activeDeploymentId: "dep_y",
      deletedAt: new Date(),
    });
    await seedProject(db, "proj_other", "org_2", { activeDeploymentId: "dep_z" });
    expect(await projectRepo.countByOrganization("org_1")).toEqual({ total: 2, active: 1 });
    expect(await projectRepo.countByOrganization("org_empty")).toEqual({ total: 0, active: 0 });
  });

  it("counts totals correctly past the old 50-project cap", async () => {
    for (let i = 0; i < 55; i++) {
      await seedProject(db, `proj_${i}`, "org_1", i % 2 === 0 ? { activeDeploymentId: `dep_${i}` } : undefined);
    }
    expect(await projectRepo.countByOrganization("org_1")).toEqual({ total: 55, active: 28 });
  });
});
