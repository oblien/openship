import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createProjectRepo } from "./project.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * The two by-server readers must describe the same set.
 *
 * `countActiveByServer` is the "N projects" chip on the fleet card; `listActiveByServer`
 * is what the "Remove server" confirm itemises and what the DELETE then tears down.
 * They resolve a project's server through the same non-obvious rule — prefer the durable
 * `project.server_id`, fall back to the active deployment's `meta.serverId` snapshot for
 * rows not yet backfilled — so the interesting cases here are the ones where a second
 * hand-written copy of that coalesce would drift: a legacy meta-only row, a soft-deleted
 * project, a project with no active deployment.
 *
 * A confirm listing 5 workloads while the card says 7 is not a cosmetic bug: the two
 * missing ones are the ones that silently keep pointing at a server that no longer exists.
 *
 * FK enforcement is off so project/deployment rows can be seeded without parents.
 */
async function freshDb() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;");
  return { db, projectRepo: createProjectRepo(db) };
}

type Db = Awaited<ReturnType<typeof freshDb>>["db"];

/**
 * Seeds a project plus its active deployment. `serverId` writes the durable binding;
 * `metaServerId` writes only the deployment snapshot (the legacy shape).
 */
async function seedBound(
  db: Db,
  id: string,
  opts: {
    organizationId?: string;
    serverId?: string | null;
    metaServerId?: string | null;
    isApp?: boolean;
    appTemplateId?: string | null;
    deletedAt?: Date | null;
    withActiveDeployment?: boolean;
  } = {},
) {
  const org = opts.organizationId ?? "org_1";
  const withDep = opts.withActiveDeployment ?? true;
  const depId = `dep_${id}`;
  if (withDep) {
    await db.insert(schema.deployment).values({
      id: depId,
      projectId: id,
      organizationId: org,
      branch: "main",
      status: "ready",
      meta: opts.metaServerId ? { serverId: opts.metaServerId } : {},
    });
  }
  await db.insert(schema.project).values({
    id,
    organizationId: org,
    groupId: `app_${id}`,
    name: id,
    slug: id,
    serverId: opts.serverId ?? null,
    isApp: opts.isApp ?? false,
    appTemplateId: opts.appTemplateId ?? null,
    activeDeploymentId: withDep ? depId : null,
    deletedAt: opts.deletedAt ?? null,
  });
}

describe("countActiveByServer and listActiveByServer describe the same set", () => {
  let db: Db;
  let projectRepo: ReturnType<typeof createProjectRepo>;

  beforeEach(async () => {
    ({ db, projectRepo } = await freshDb());
  }, 30_000);

  /** The invariant, asserted as a helper so every case below checks it. */
  async function expectAgreement(serverId: string, expected: number) {
    const counts = await projectRepo.countActiveByServer("org_1");
    const rows = await projectRepo.listActiveByServer("org_1", serverId);
    expect(rows).toHaveLength(expected);
    expect(counts[serverId] ?? 0).toBe(expected);
  }

  it("agrees on a durable server_id binding", async () => {
    await seedBound(db, "p1", { serverId: "srv1" });
    await expectAgreement("srv1", 1);
  });

  it("agrees on a legacy row bound only through meta.serverId", async () => {
    // The fallback half of the coalesce. A list that queried `project.server_id`
    // alone would show nothing here while the chip said 1 — and the DELETE would
    // then leave this project pointing at a deleted server.
    await seedBound(db, "p1", { serverId: null, metaServerId: "srv1" });
    await expectAgreement("srv1", 1);
  });

  it("prefers the durable binding over a stale deployment snapshot", async () => {
    // The project moved to srv2; its last deployment still remembers srv1.
    await seedBound(db, "p1", { serverId: "srv2", metaServerId: "srv1" });
    await expectAgreement("srv2", 1);
    await expectAgreement("srv1", 0);
  });

  it("agrees that a soft-deleted project is on no server", async () => {
    await seedBound(db, "gone", { serverId: "srv1", deletedAt: new Date() });
    await expectAgreement("srv1", 0);
  });

  it("agrees that a project with no active deployment is on no server", async () => {
    // Both readers inner-join the active deployment: a draft has nothing running to
    // tear down, so it must not appear in either.
    await seedBound(db, "draft", { serverId: "srv1", withActiveDeployment: false });
    await expectAgreement("srv1", 0);
  });

  it("agrees across a mixed fleet, and never leaks another server's workloads", async () => {
    await seedBound(db, "a", { serverId: "srv1" });
    await seedBound(db, "b", { serverId: null, metaServerId: "srv1" });
    await seedBound(db, "c", { serverId: "srv1", isApp: true, appTemplateId: "plausible" });
    await seedBound(db, "d", { serverId: "srv2" });
    await seedBound(db, "e", { serverId: "srv1", deletedAt: new Date() });

    await expectAgreement("srv1", 3);
    await expectAgreement("srv2", 1);
    const rows = await projectRepo.listActiveByServer("org_1", "srv1");
    expect(rows.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("stays inside the organization", async () => {
    await seedBound(db, "mine", { serverId: "srv1" });
    await seedBound(db, "theirs", { organizationId: "org_2", serverId: "srv1" });
    const rows = await projectRepo.listActiveByServer("org_1", "srv1");
    expect(rows.map((r) => r.id)).toEqual(["mine"]);
  });

  it("carries what the confirm needs to render and the delete needs to decide", async () => {
    await db.insert(schema.projectGroup).values({
      id: "app_p1",
      organizationId: "org_1",
      name: "Analytics",
      slug: "analytics",
    });
    await seedBound(db, "p1", { serverId: "srv1", isApp: true, appTemplateId: "plausible" });
    const [row] = await projectRepo.listActiveByServer("org_1", "srv1");
    expect(row).toMatchObject({
      id: "p1",
      name: "p1",
      environmentName: "Production",
      environmentSlug: "production",
      groupName: "Analytics",
      isApp: true,
      // `appTemplateId` is how both the preview and the DELETE recognise the control
      // plane, which teardown refuses — without it the removal would list a guaranteed
      // failure as a promise.
      appTemplateId: "plausible",
      activeDeploymentId: "dep_p1",
    });
  });

  it("names an app whose group row is missing without dropping it", async () => {
    // Left join, not inner: a workload with no group still has to be torn down.
    await seedBound(db, "p1", { serverId: "srv1", isApp: true });
    const [row] = await projectRepo.listActiveByServer("org_1", "srv1");
    expect(row?.id).toBe("p1");
    expect(row?.groupName).toBeNull();
  });
});
