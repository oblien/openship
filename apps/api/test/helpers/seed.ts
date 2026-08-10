/**
 * Row seeding for tests that need REAL org / project / deployment records.
 *
 * `@repo/db` opens a fresh, fully-migrated in-memory PGlite per test file under
 * Vitest, so these write to a real database — no repo mocks — which is what lets
 * a test drive the orchestrator's own policy code instead of a stand-in.
 *
 * Mirrors the idioms in test/modules/jobs/_harness.ts (which seeds an owner +
 * server for the jobs router); this one covers the deployment side, which had no
 * factory at all.
 */

import { db, repos, schema } from "@repo/db";

let seq = 0;
const uid = (prefix: string) => `${prefix}_${seq++}_${Math.trunc(performance.now())}`;

export interface SeededOrg {
  userId: string;
  organizationId: string;
}

export async function seedOrg(): Promise<SeededOrg> {
  const userId = uid("user");
  const organizationId = uid("org");
  await db.insert(schema.user).values({
    id: userId,
    name: "Test Owner",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(schema.organization).values({
    id: organizationId,
    name: "Test Org",
    slug: organizationId,
  });
  await db.insert(schema.member).values({
    id: uid("member"),
    organizationId,
    userId,
    role: "owner",
  });
  return { userId, organizationId };
}

/**
 * A project (= one environment) under its own group row. `project.app_id` is NOT
 * NULL — every project belongs to a group ("project app"), which is what shares
 * one repo across Production/Preview environments — so seeding a project means
 * seeding both.
 */
export async function seedProject(
  organizationId: string,
  over: Partial<typeof schema.project.$inferInsert> = {},
) {
  const id = uid("proj");
  const groupId = over.groupId ?? uid("app");
  if (!over.groupId) {
    await db.insert(schema.projectGroup).values({
      id: groupId,
      organizationId,
      name: over.name ?? id,
      slug: over.slug ?? id,
    });
  }
  const [row] = await db
    .insert(schema.project)
    .values({
      id,
      organizationId,
      groupId,
      name: over.name ?? id,
      slug: over.slug ?? id,
      ...over,
    })
    .returning();
  return row!;
}

/**
 * A deployment row in the shape the deploy pipeline leaves behind on success —
 * `meta` carries the frozen config snapshot a restore replays.
 */
export async function seedDeployment(
  project: { id: string; organizationId: string },
  over: Partial<typeof schema.deployment.$inferInsert> = {},
) {
  const id = uid("dep");
  const [row] = await db
    .insert(schema.deployment)
    .values({
      id,
      projectId: project.id,
      organizationId: project.organizationId,
      branch: over.branch ?? "main",
      environment: over.environment ?? "production",
      status: over.status ?? "ready",
      ...over,
    })
    .returning();
  return row!;
}

export async function setActive(projectId: string, deploymentId: string) {
  await repos.project.setActiveDeployment(projectId, deploymentId);
}

/**
 * A compose service row + (optionally) the per-service deployment row that
 * records which image it was running in a given release.
 *
 * Compose is where "did service X change?" matters: an untouched service carries
 * its previous image forward, so restore correctness depends on these rows.
 */
export async function seedService(
  projectId: string,
  over: Partial<typeof schema.service.$inferInsert> & { name: string },
) {
  const id = uid("svc");
  const [row] = await db
    .insert(schema.service)
    .values({ id, projectId, kind: "compose", ...over })
    .returning();
  return row!;
}

export async function seedServiceDeployment(
  deploymentId: string,
  service: { id: string; name: string },
  over: Partial<typeof schema.serviceDeployment.$inferInsert> = {},
) {
  const id = uid("sd");
  const [row] = await db
    .insert(schema.serviceDeployment)
    .values({
      id,
      deploymentId,
      serviceId: service.id,
      serviceName: service.name,
      status: "success",
      ...over,
    })
    .returning();
  return row!;
}

/* ── Backups ─────────────────────────────────────────────────────────────── */

export async function seedBackupDestination(
  organizationId: string,
  over: Partial<typeof schema.backupDestination.$inferInsert> = {},
) {
  const id = uid("bkd");
  const [row] = await db
    .insert(schema.backupDestination)
    .values({ id, organizationId, name: over.name ?? id, kind: over.kind ?? "local", ...over })
    .returning();
  return row!;
}

export async function seedBackupPolicy(
  destinationId: string,
  over: Partial<typeof schema.backupPolicy.$inferInsert> = {},
) {
  const id = uid("bkp");
  const [row] = await db
    .insert(schema.backupPolicy)
    .values({ id, destinationId, ...over })
    .returning();
  return row!;
}

/**
 * A finished run. `artifacts` is the write-once record of what was captured and
 * how to put it back — the D5 backfill's whole subject — so callers pass it
 * explicitly rather than getting a default they'd have to reason about.
 */
export async function seedBackupRun(
  organizationId: string,
  over: Partial<typeof schema.backupRun.$inferInsert> = {},
) {
  const id = uid("bkr");
  const [row] = await db
    .insert(schema.backupRun)
    .values({
      id,
      organizationId,
      status: over.status ?? "succeeded",
      triggeredBy: over.triggeredBy ?? "manual",
      ...over,
    })
    .returning();
  return row!;
}
