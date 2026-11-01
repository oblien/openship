import { createEncryption } from "../encryption";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { buildSession, deployment } from "../schema";
import { createDeploymentRepo } from "./deployment.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * `listUnsettledByProject` feeds the project move guard: every deployment whose
 * containers may still run outside the active release. It must not page, and it
 * must keep a cancelled deployment that preserved its containers after its
 * execution finished, because nothing else retires those containers.
 */
async function freshRepo() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;"); // skip FK seeding
  const repo = createDeploymentRepo(db, createEncryption("repository-test-secret"));
  return { db, repo };
}

const row = (
  id: string,
  status: string,
  meta: Record<string, unknown> | null = null,
  projectId = "p1",
) => ({ id, projectId, organizationId: "org1", status, branch: "main", meta });

describe("listUnsettledByProject", () => {
  // A project holds at most one queued, building or deploying row at a time.
  it.each(["queued", "building", "deploying"])("returns a %s deployment", async (status) => {
    const { db, repo } = await freshRepo();
    await db.insert(deployment).values([row("in-flight", status), row("ready", "ready")]);
    expect((await repo.listUnsettledByProject("p1")).map((dep) => dep.id)).toEqual(["in-flight"]);
  });

  it("returns reconciling and preserved deployments of the project, and nothing settled", async () => {
    const { db, repo } = await freshRepo();
    const preserved = { cancellation: { keepProvisioned: true } };
    await db
      .insert(deployment)
      .values([
        row("reconciling", "reconciling"),
        row("ready", "ready"),
        row("failed", "failed"),
        row("cancelled", "cancelled"),
        row("cancelled-running", "cancelled"),
        row("preserved-finished", "cancelled", preserved),
        row("preserved-false", "cancelled", { cancellation: { keepProvisioned: false } }),
        row("other-project", "queued", null, "p2"),
      ]);
    await db.insert(buildSession).values([
      {
        id: "s-running",
        deploymentId: "cancelled-running",
        projectId: "p1",
        startedAt: new Date(),
      },
      {
        id: "s-preserved",
        deploymentId: "preserved-finished",
        projectId: "p1",
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    ]);

    const ids = (await repo.listUnsettledByProject("p1")).map((dep) => dep.id).sort();

    expect(ids).toEqual(["cancelled-running", "preserved-finished", "reconciling"]);
  });

  it("is not limited to one history page", async () => {
    const { db, repo } = await freshRepo();
    await db.insert(deployment).values(
      Array.from({ length: 150 }, (_, i) => ({
        id: `r${i}`,
        projectId: "p1",
        organizationId: "org1",
        status: "reconciling",
        branch: "main",
      })),
    );

    expect(await repo.listUnsettledByProject("p1")).toHaveLength(150);
  });
});
