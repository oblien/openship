import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createServiceRepo } from "./service.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Recording a service FAILURE must not depend on the row not existing yet.
 *
 * `service_deployment` carries `uq_service_deployment_dep_svc` UNIQUE on
 * (deployment_id, service_id), and a deploy has two writers: the smart-deploy path
 * pre-creates a `skipped` row for every service it did not target, and the compose
 * path writes the services it did. So by the time a dependency failure needs
 * recording, a row for that pair very often already exists — and a plain INSERT
 * there raised a unique violation that killed the deploy on its own BOOKKEEPING,
 * hiding whatever actually failed.
 *
 * The other half is just as important: the row it collides with holds the LIVE
 * runtime details of a container that is still running (`container_id`,
 * `image_digest`, `host_port`, `host_ports`, `ip`). A full-row upsert would blank
 * those, which is why this cannot simply reuse `upsertServiceDeployment` — recording
 * that service B failed must not erase what service A is running.
 */
async function fresh() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  // Seed rows without the full org→project→service FK chain.
  await client.exec("SET session_replication_role = replica;");
  return { db, repo: createServiceRepo(db) };
}

const DEP = "dep_1";
const SVC = "svc_postgres";

let ctx: Awaited<ReturnType<typeof fresh>>;

beforeEach(async () => {
  ctx = await fresh();
});

function readRow() {
  return ctx.db.query.serviceDeployment.findFirst({
    where: and(
      eq(schema.serviceDeployment.deploymentId, DEP),
      eq(schema.serviceDeployment.serviceId, SVC),
    ),
  });
}

async function countRows() {
  const rows = await ctx.db.query.serviceDeployment.findMany({
    where: eq(schema.serviceDeployment.deploymentId, DEP),
  });
  return rows.length;
}

/** What the smart-deploy path pre-creates for an untargeted, still-running service. */
async function seedCarriedForwardRow() {
  await ctx.db.insert(schema.serviceDeployment).values({
    id: "sd_existing",
    deploymentId: DEP,
    serviceId: SVC,
    serviceName: "postgres",
    status: "skipped",
    reason: "unchanged",
    reasonSkipped: "unchanged",
    imageRef: "postgres:16-alpine",
    imageDigest: "sha256:deadbeef",
    containerId: "container_abc",
    hostPort: 5432,
    hostPorts: { "5432": 15432, "5433": 15433 },
    ip: "172.18.0.5",
  });
}

describe("markServiceDeploymentFailed", () => {
  it("inserts when no row exists yet", async () => {
    await ctx.repo.markServiceDeploymentFailed({
      deploymentId: DEP,
      serviceId: SVC,
      serviceName: "postgres",
      imageRef: "postgres:16-alpine",
      errorMessage: "boom",
    });

    const row = await readRow();
    expect(row?.status).toBe("failure");
    expect(row?.errorMessage).toBe("boom");
    expect(row?.imageRef).toBe("postgres:16-alpine");
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  // THE regression. A plain insert here is the unique violation that surfaced as
  // "Failed query: insert into service_deployment" and aborted the deploy.
  it("does not throw when a row for the pair already exists", async () => {
    await seedCarriedForwardRow();

    await expect(
      ctx.repo.markServiceDeploymentFailed({
        deploymentId: DEP,
        serviceId: SVC,
        serviceName: "postgres",
        imageRef: "postgres:16-alpine",
        errorMessage: "Skipped because required service api did not deploy.",
      }),
    ).resolves.not.toThrow();

    // Updated in place — the unique index permits exactly one row per pair.
    expect(await countRows()).toBe(1);
    const row = await readRow();
    expect(row?.status).toBe("failure");
    expect(row?.errorMessage).toContain("did not deploy");
  });

  it("PRESERVES the live runtime fields of the row it updates", async () => {
    // The reason this is not `upsertServiceDeployment`: that one coalesces these to
    // null, so recording a failure would erase the record of a running container.
    await seedCarriedForwardRow();

    await ctx.repo.markServiceDeploymentFailed({
      deploymentId: DEP,
      serviceId: SVC,
      serviceName: "postgres",
      errorMessage: "dependency failed",
    });

    const row = await readRow();
    expect(row?.containerId).toBe("container_abc");
    expect(row?.imageDigest).toBe("sha256:deadbeef");
    expect(row?.hostPort).toBe(5432);
    expect(row?.hostPorts).toEqual({ "5432": 15432, "5433": 15433 });
    expect(row?.ip).toBe("172.18.0.5");
  });

  it("keeps the existing imageRef when the failure knew none", async () => {
    // Several call sites fail before an image is resolved. Passing null there must
    // not blank the image the carried-forward row recorded.
    await seedCarriedForwardRow();

    await ctx.repo.markServiceDeploymentFailed({
      deploymentId: DEP,
      serviceId: SVC,
      serviceName: "postgres",
      errorMessage: "no image resolved",
    });

    expect((await readRow())?.imageRef).toBe("postgres:16-alpine");
  });

  it("overwrites imageRef when the failure DID resolve one", async () => {
    await seedCarriedForwardRow();

    await ctx.repo.markServiceDeploymentFailed({
      deploymentId: DEP,
      serviceId: SVC,
      serviceName: "postgres",
      imageRef: "postgres:17-alpine",
      errorMessage: "started the new image and it died",
    });

    expect((await readRow())?.imageRef).toBe("postgres:17-alpine");
  });

  it("records the reason so it outlives the deploy's SSE session", async () => {
    // Every call site already had this message in hand for its live broadcast and
    // was discarding it, which is why a finished deploy showed status=failure with
    // no explanation anywhere.
    await ctx.repo.markServiceDeploymentFailed({
      deploymentId: DEP,
      serviceId: SVC,
      serviceName: "postgres",
      errorMessage: "port 5432 already allocated",
      reason: "port-conflict",
    });

    const row = await readRow();
    expect(row?.errorMessage).toBe("port 5432 already allocated");
    expect(row?.reason).toBe("port-conflict");
  });

  it("is idempotent across repeated failures for the same pair", async () => {
    for (const msg of ["first", "second", "third"]) {
      await ctx.repo.markServiceDeploymentFailed({
        deploymentId: DEP,
        serviceId: SVC,
        serviceName: "postgres",
        errorMessage: msg,
      });
    }
    expect(await countRows()).toBe(1);
    expect((await readRow())?.errorMessage).toBe("third");
  });

  it("accepts a non-default status without hardcoding 'failure'", async () => {
    await ctx.repo.markServiceDeploymentFailed({
      deploymentId: DEP,
      serviceId: SVC,
      serviceName: "postgres",
      status: "cancelled",
      errorMessage: "operator cancelled the deploy",
    });
    expect((await readRow())?.status).toBe("cancelled");
  });
});
