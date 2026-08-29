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
 * GH-585. `service_deployment` carries `uq_service_deployment_dep_svc` UNIQUE on
 * (deployment_id, service_id), and a deploy has TWO writers for that pair: a scoped deploy
 * pre-creates a `skipped` row for every service it did not target (service-checks.ts), and
 * the compose loop writes the ones it actually deployed. So a row very often already exists
 * by the time an outcome is known.
 *
 * Every write in that loop must therefore survive the collision. It didn't: a plain INSERT
 * raised a unique violation that propagated out of `deployComposeServices` uncaught, and the
 * compose pipeline only handles a *returned* failure — so the whole deployment errored out on
 * its own bookkeeping, hiding whatever actually happened. The sibling suite
 * (service-deployment-failure-upsert.test.ts) covers the FAILURE writer; this one covers the
 * skip writer and the success/indeterminate path.
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
const SVC = "svc_worker";

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

/** Exactly what `preCreateServiceDeployments` writes for an UNTARGETED service. */
async function seedPreCreatedSkippedRow() {
  await ctx.db.insert(schema.serviceDeployment).values({
    id: "sd_precreated",
    deploymentId: DEP,
    serviceId: SVC,
    serviceName: "worker",
    status: "skipped",
    reason: "unchanged",
    reasonSkipped: "unchanged",
  });
}

/** An untargeted service that IS still running — the carry-forward row. */
async function seedCarriedForwardRow() {
  await ctx.db.insert(schema.serviceDeployment).values({
    id: "sd_carried",
    deploymentId: DEP,
    serviceId: SVC,
    serviceName: "worker",
    status: "skipped",
    reason: "unchanged",
    reasonSkipped: "unchanged",
    imageRef: "openship/worker:v3",
    imageDigest: "sha256:deadbeef",
    containerId: "container_abc",
    hostPort: 9411,
    hostPorts: { "9411": 19411, "9412": 19412 },
    ip: "172.18.0.7",
  });
}

describe("markServiceDeploymentSkipped", () => {
  it("inserts when no row exists yet", async () => {
    await ctx.repo.markServiceDeploymentSkipped({
      deploymentId: DEP,
      serviceId: SVC,
      serviceName: "worker",
      reason: "out-of-scope",
    });

    const row = await readRow();
    expect(row?.status).toBe("skipped");
    expect(row?.reason).toBe("out-of-scope");
    // Mirrored for the legacy readers of reasonSkipped.
    expect(row?.reasonSkipped).toBe("out-of-scope");
  });

  // The pre-created row is the common case: it exists for exactly the untargeted services
  // this writer is called for.
  it("updates the pre-created row in place instead of raising a unique violation", async () => {
    await seedPreCreatedSkippedRow();

    await expect(
      ctx.repo.markServiceDeploymentSkipped({
        deploymentId: DEP,
        serviceId: SVC,
        serviceName: "worker",
        reason: "out-of-scope",
      }),
    ).resolves.not.toThrow();

    expect(await countRows()).toBe(1);
    // "out-of-scope" replaces the optimistic "unchanged": the service wasn't unchanged, it
    // has never been built at all, and that is what the operator needs to read.
    expect((await readRow())?.reason).toBe("out-of-scope");
  });

  it("PRESERVES the live runtime fields of the row it updates", async () => {
    // Why this is not `upsertServiceDeployment`: that one coalesces these to null, so
    // recording a skip would erase the record of a container that is still running.
    await seedCarriedForwardRow();

    await ctx.repo.markServiceDeploymentSkipped({
      deploymentId: DEP,
      serviceId: SVC,
      serviceName: "worker",
      reason: "out-of-scope",
    });

    const row = await readRow();
    expect(row?.containerId).toBe("container_abc");
    expect(row?.imageRef).toBe("openship/worker:v3");
    expect(row?.imageDigest).toBe("sha256:deadbeef");
    expect(row?.hostPort).toBe(9411);
    expect(row?.hostPorts).toEqual({ "9411": 19411, "9412": 19412 });
    expect(row?.ip).toBe("172.18.0.7");
  });

  it("is idempotent across repeated calls for the same pair", async () => {
    for (let i = 0; i < 3; i += 1) {
      await ctx.repo.markServiceDeploymentSkipped({
        deploymentId: DEP,
        serviceId: SVC,
        serviceName: "worker",
        reason: "out-of-scope",
      });
    }
    expect(await countRows()).toBe(1);
  });
});

describe("upsertServiceDeployment over a pre-created skipped row", () => {
  /**
   * THE regression behind #585's reported crash. An untargeted service still reaches the
   * compose loop's create sites in two real shapes — its container turned out to be gone and
   * the carry revived it, or it is a STATIC sub-app (which owns no container, so the carry
   * branch can never keep it and it always falls through). Both used to finish with a plain
   * INSERT against a pair that the pre-create had already written.
   */
  it("records a successful deploy without raising a unique violation", async () => {
    await seedPreCreatedSkippedRow();

    await expect(
      ctx.repo.upsertServiceDeployment({
        deploymentId: DEP,
        serviceId: SVC,
        serviceName: "worker",
        containerId: "container_new",
        status: "success",
        imageRef: "openship/worker:v4",
        imageDigest: "sha256:cafebabe",
        hostPort: 9411,
        hostPorts: { "3000": 9411, "3001": 9412 },
        ip: "172.18.0.9",
      }),
    ).resolves.not.toThrow();

    expect(await countRows()).toBe(1);
    const row = await readRow();
    expect(row?.status).toBe("success");
    expect(row?.containerId).toBe("container_new");
    expect(row?.imageDigest).toBe("sha256:cafebabe");
    expect(row?.hostPorts).toEqual({ "3000": 9411, "3001": 9412 });
    // The stale skip bookkeeping must not outlive the row's new meaning.
    expect(row?.reason).toBeNull();
    expect(row?.reasonSkipped).toBeNull();
  });

  it("records an indeterminate outcome without raising a unique violation", async () => {
    await seedPreCreatedSkippedRow();

    await expect(
      ctx.repo.upsertServiceDeployment({
        deploymentId: DEP,
        serviceId: SVC,
        serviceName: "worker",
        containerId: "container_started",
        status: "indeterminate",
        imageRef: "openship/worker:v4",
      }),
    ).resolves.not.toThrow();

    expect(await countRows()).toBe(1);
    expect((await readRow())?.status).toBe("indeterminate");
  });
});
