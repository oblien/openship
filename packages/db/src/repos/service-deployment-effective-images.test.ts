import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createServiceDeploymentRepo } from "./service-deployment.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * "What was service X actually running in that release?"
 *
 * A deploy only rebuilds what changed, so a release's own rows do NOT always
 * name an image for every service: an untouched service carries its previous one
 * forward, and a smart-deploy `skipped` row records none. A rollback that reads
 * only the target's rows would therefore rebuild services whose image is already
 * sitting on the host — which is the whole cost it exists to avoid.
 */
async function fresh() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  // Seed rows without the full org→project→service chain.
  await client.exec("SET session_replication_role = replica;");
  return { db, repo: createServiceDeploymentRepo(db) };
}

const PROJECT = "proj_1";
let ctx: Awaited<ReturnType<typeof fresh>>;

/** service rows, so the repo's join can scope by project. */
async function seedServices(names: string[]) {
  for (const name of names) {
    await ctx.db.insert(schema.service).values({
      id: `svc_${name}`,
      projectId: PROJECT,
      name,
      kind: "compose",
    });
  }
}

async function seedRow(opts: {
  deploymentId: string;
  service: string;
  imageRef?: string | null;
  status?: string;
  minutesAgo: number;
}) {
  await ctx.db.insert(schema.serviceDeployment).values({
    id: `sd_${opts.deploymentId}_${opts.service}`,
    deploymentId: opts.deploymentId,
    serviceId: `svc_${opts.service}`,
    serviceName: opts.service,
    status: opts.status ?? "success",
    imageRef: opts.imageRef ?? null,
    createdAt: new Date(Date.now() - opts.minutesAgo * 60_000),
  });
}

beforeEach(async () => {
  ctx = await fresh();
  await seedServices(["web", "api", "db"]);
});

describe("effectiveImagesAsOf", () => {
  it("resolves the newest image at-or-before the given moment, per service", async () => {
    // d1 built everything; d2 rebuilt only `web`.
    await seedRow({ deploymentId: "d1", service: "web", imageRef: "web:1", minutesAgo: 30 });
    await seedRow({ deploymentId: "d1", service: "api", imageRef: "api:1", minutesAgo: 30 });
    await seedRow({ deploymentId: "d1", service: "db", imageRef: "postgres:16", minutesAgo: 30 });
    await seedRow({ deploymentId: "d2", service: "web", imageRef: "web:2", minutesAgo: 10 });
    // `api` was skipped in d2 and recorded no image at all.
    await seedRow({ deploymentId: "d2", service: "api", status: "skipped", minutesAgo: 10 });

    const asOfD2 = await ctx.repo.effectiveImagesAsOf(PROJECT, new Date(Date.now() - 5 * 60_000));
    expect(asOfD2.get("svc_web")?.imageRef).toBe("web:2");
    // …but it was still RUNNING api:1 — the image d1 built, still on the host.
    expect(asOfD2.get("svc_api")?.imageRef).toBe("api:1");
    expect(asOfD2.get("svc_db")?.imageRef).toBe("postgres:16");
  });

  it("does not look FORWARD past the target release", async () => {
    await seedRow({ deploymentId: "d1", service: "web", imageRef: "web:1", minutesAgo: 30 });
    await seedRow({ deploymentId: "d2", service: "web", imageRef: "web:2", minutesAgo: 10 });

    // Restoring d1 must see web:1, not the newer web:2.
    const asOfD1 = await ctx.repo.effectiveImagesAsOf(PROJECT, new Date(Date.now() - 20 * 60_000));
    expect(asOfD1.get("svc_web")?.imageRef).toBe("web:1");
  });

  it("ignores rows that never recorded an image", async () => {
    await seedRow({ deploymentId: "d1", service: "web", status: "failure", minutesAgo: 30 });
    const asOf = await ctx.repo.effectiveImagesAsOf(PROJECT, new Date());
    expect(asOf.has("svc_web")).toBe(false);
  });

  it("scopes to the project", async () => {
    await ctx.db.insert(schema.service).values({
      id: "svc_other",
      projectId: "proj_other",
      name: "web",
      kind: "compose",
    });
    await ctx.db.insert(schema.serviceDeployment).values({
      id: "sd_other",
      deploymentId: "d_other",
      serviceId: "svc_other",
      serviceName: "web",
      status: "success",
      imageRef: "other:1",
    });
    const asOf = await ctx.repo.effectiveImagesAsOf(PROJECT, new Date());
    expect(asOf.has("svc_other")).toBe(false);
  });
});
