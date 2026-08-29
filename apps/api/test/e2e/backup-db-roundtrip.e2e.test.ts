/**
 * A REAL database, dumped and reloaded — the logical-dump path against a live Postgres.
 *
 * `backup-payload-matrix.e2e.test.ts` covers every FILESYSTEM shape (volumes, subsets,
 * binds, folders, quiesce, custom_command) and deliberately runs no database image. The
 * dump producers' generated shell is covered by unit tests that run it under `dash`
 * (`backup-dump-pipeline.test.ts`). Neither of those can see the three things that only
 * a real engine decides:
 *
 *   1. **Which producer `auto` picks, on a service that would also work as a volume.**
 *      This is #611 exactly: a postgres service has volumes, so the fallback SUCCEEDS —
 *      it writes a crash-consistent tar of a live data directory and reports green. The
 *      only proof that the logical dump won is the recorded `payloadKind`, and the only
 *      way to get it is to run detection against a real container. It also exercises the
 *      env enrichment that #611 turned on: the service ROW carries no `POSTGRES_*` at
 *      all here, so the credentials come from the running container or not at all.
 *
 *   2. **That a FAILED restore of this kind changes nothing.** `pg_restore` runs under
 *      `--single-transaction`, which is the whole reason `pg_dump` is the one kind the
 *      catalog lets claim `restoreFailureLeavesTargetIntact`. That claim is what
 *      SUPPRESSES the "the target holds partial data and the service was deliberately
 *      left stopped" banner — a suppression, so if it is ever wrong it is wrong in the
 *      dangerous direction. A unit test can assert the flag; only a real cluster can
 *      assert that the rows are still there.
 *
 *   3. **That `--no-acl` is load-bearing rather than tidy.** A single-database `-Fc`
 *      archive carries its GRANTs but not the cluster-global roles they name, so under
 *      one transaction a grant to a role that no longer exists would abort the entire
 *      restore and land nothing — the disaster-recovery case, restoring into a fresh
 *      cluster, is precisely where that happens. The test pins the premise (the same
 *      GRANT really does error against this cluster) before proving the restore survives
 *      it, so it cannot pass vacuously if Postgres ever started ignoring it.
 *
 * The container is never stopped for any of this, and that is asserted rather than
 * assumed: `restoreNeedsLiveContainer` is true for `pg_dump`, and the bug it was written
 * for was a restore that stopped the container and then tried to `exec` into it.
 *
 * SQL runs through `docker exec … psql` with an ARGV, never a shell string — the official
 * image trusts local socket connections, so no password travels and no quoting can break.
 *
 * Skips without a reachable daemon, FAILS under RUN_DOCKER_E2E=1 (what CI sets).
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DockerRuntime, initPlatform, resetPlatform, scopedVolumeName } from "@repo/adapters";
import { repos } from "@repo/db";
import { env } from "../../src/config";
import type { RequestContext } from "../../src/lib/request-context";
import { resolvePlatformConfig } from "../../src/lib/controller-helpers";
import { backupE2EHarness } from "../helpers/backup-e2e";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import {
  seedOrg,
  seedProject,
  seedDeployment,
  setActive,
  seedService,
  seedServiceDeployment,
  seedBackupDestination,
  seedBackupPolicy,
} from "../helpers/seed";

const IMAGE = "postgres:16-alpine";
const PGDATA = "/var/lib/postgresql/data";
/** Only the password, on purpose — see the `db` derivation in producers/pg-dump.ts. */
const PG_PASSWORD = "e2e-not-used-over-the-socket";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeDockerE2E("logical database backup — pg_dump against a live Postgres", () => {
  let runtime: DockerRuntime;
  let ctx: RequestContext;
  let organizationId = "";
  let projectId = "";
  let serviceId = "";
  let destinationId = "";
  let policyId = "";
  let destRoot = "";
  let dataVolume = "";
  let containerId = "";

  const { capture, beginRestore, restore, waitForRestore } = backupE2EHarness(() => ({
    ctx,
    organizationId,
    projectId,
    serviceId,
    policyId,
    destinationId,
    destRoot,
  }));

  /** One `docker exec`, ARGV form, output and exit status both. */
  const execIn = async (cmd: string[]): Promise<{ code: number; out: string }> => {
    const exec = await runtime.docker.getContainer(containerId).exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false, Tty: true });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    const info = (await exec.inspect()) as { ExitCode: number | null };
    // `Tty: true` means one merged stream and CRLF line endings; strip the CRs so
    // assertions can compare against ordinary strings.
    return { code: info.ExitCode ?? -1, out: Buffer.concat(chunks).toString("utf8").replace(/\r/g, "") };
  };

  /** Fixture SQL. `ON_ERROR_STOP` so a broken fixture fails here, not three asserts later. */
  const sql = async (statement: string): Promise<string> => {
    const { code, out } = await execIn([
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tAc",
      statement,
    ]);
    if (code !== 0) throw new Error(`psql exited ${code} running \`${statement}\`: ${out}`);
    return out.trim();
  };

  /** The daemon's own view of the container — the claim "we never stopped it" rests on it. */
  const containerState = async (): Promise<{
    Running: boolean;
    Paused: boolean;
    StartedAt: string;
  }> =>
    (await runtime.docker.getContainer(containerId).inspect()).State as {
      Running: boolean;
      Paused: boolean;
      StartedAt: string;
    };

  beforeAll(async () => {
    await requireDocker();
    await initPlatform(resolvePlatformConfig());
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage(IMAGE);

    const org = await seedOrg();
    organizationId = org.organizationId;
    const slug = `bk-db-${randomBytes(4).toString("hex")}`;
    const project = await seedProject(organizationId, { slug, name: slug });
    projectId = project.id;

    const dep = await seedDeployment(project, {
      status: "ready",
      meta: { deployTarget: "local", runtimeMode: "docker" } as never,
    });
    await setActive(projectId, dep.id);

    dataVolume = scopedVolumeName(slug, "pgdata");
    await runtime.docker.createVolume({ Name: dataVolume });

    // A service row with a volume and NO env. Both halves matter: the volume is what
    // makes the fallback a working answer (so "it picked pg_dump" is a real choice, not
    // the only survivor), and the empty env is the #611 shape — the control plane's own
    // postgres, whose service rows are built from running containers and record nothing.
    const service = await seedService(projectId, {
      name: "db",
      image: IMAGE,
      volumes: [`pgdata:${PGDATA}`],
      namespaceVolumes: true,
    });
    serviceId = service.id;

    const container = await runtime.docker.createContainer({
      Image: IMAGE,
      Env: [`POSTGRES_PASSWORD=${PG_PASSWORD}`],
      Labels: { "openship.project": projectId, "openship.service": "db" },
      HostConfig: { Binds: [`${dataVolume}:${PGDATA}`], AutoRemove: false },
    });
    await container.start();
    containerId = container.id;
    await seedServiceDeployment(dep.id, { id: serviceId, name: "db" }, { containerId });

    // initdb runs on first boot, so "running" is not "ready" — and an exec against a
    // cluster mid-initialization fails in ways that would read as a product bug.
    const deadline = Date.now() + 120_000;
    for (;;) {
      // The postgres entrypoint starts a temporary socket-only server during initdb,
      // then stops it before execing the final server. Probing TCP avoids passing in
      // that temporary phase and racing the shutdown gap with the first fixture query.
      const probe = await execIn([
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ]);
      if (probe.code === 0) break;
      if (Date.now() > deadline) throw new Error(`postgres never became ready: ${probe.out}`);
      await sleep(500);
    }

    await mkdir(env.BACKUP_LOCAL_ROOT, { recursive: true });
    destRoot = await mkdtemp(join(env.BACKUP_LOCAL_ROOT, "db-"));
    const destination = await seedBackupDestination(organizationId, {
      kind: "local",
      endpoint: destRoot,
    });
    destinationId = destination.id;
    // `payloadKind: "auto"` is the column default and what an operator gets by leaving
    // the dialog alone, so it is what the first case has to exercise.
    const policy = await seedBackupPolicy(destinationId, {
      projectId,
      serviceId,
      sourceKind: "service",
      payloadKind: "auto",
      enabled: true,
    });
    policyId = policy.id;

    ctx = { userId: org.userId, organizationId } as unknown as RequestContext;
  }, 300_000);

  afterAll(async () => {
    if (containerId) {
      await runtime.docker.getContainer(containerId).remove({ force: true }).catch(() => {});
    }
    if (dataVolume) await runtime.docker.getVolume(dataVolume).remove({ force: true }).catch(() => {});
    // Only this file's subtree: the root is shared with the other backup E2E files and
    // `fileParallelism: false` only means they don't overlap in TIME, not that one may
    // delete another's sandbox.
    if (destRoot) await rm(destRoot, { recursive: true, force: true }).catch(() => {});
    await runtime?.dispose?.().catch(() => {});
    resetPlatform();
  }, 120_000);

  it("picks pg_dump over the volume fallback and round-trips the data", async () => {
    await sql(
      "DROP TABLE IF EXISTS widgets; CREATE TABLE widgets(id int primary key, label text); " +
        "INSERT INTO widgets VALUES (1,'alpha'),(2,'beta')",
    );

    const { runId, artifacts } = await capture("auto", {});

    // The #611 assertion. A volume artifact here would be a green backup of a live data
    // directory — restorable in principle, torn in practice, and indistinguishable from
    // this one in every UI.
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].payloadKind).toBe("pg_dump");
    expect(artifacts[0].name).toBe("pg-dump.dump");
    // Derived, not read from env: the image's own rule is POSTGRES_DB → POSTGRES_USER →
    // `postgres`, and nothing in this fixture sets either of the first two.
    expect(artifacts[0].metadata.postgresDb).toBe("postgres");
    expect(artifacts[0].metadata.postgresUser).toBe("postgres");
    expect(artifacts[0].metadata.format).toBe("custom");
    // `-Fc` is zlib-compressed internally; the recorded codec is the EXTERNAL one, and
    // getting this wrong sends the artifact through a decompressor that cannot read it.
    expect(artifacts[0].metadata.compression).toBe("none");

    const before = await containerState();
    // DROP, not DELETE: `--clean` has to rebuild the schema too, which is the half a
    // data-only comparison would never notice was missing.
    await sql("DROP TABLE widgets");

    const row = await restore(runId);

    expect(await sql("SELECT count(*) FROM widgets")).toBe("2");
    expect(await sql("SELECT label FROM widgets ORDER BY id")).toBe("alpha\nbeta");

    // Never stopped, never bounced — the same container, still up, same boot. The bug
    // this pins: apply used to stop the service and then `exec` into it, and the daemon
    // answered `409 … is not running`, so every logical-dump restore failed on a service
    // that was running normally.
    const after = await containerState();
    expect(after.Running).toBe(true);
    expect(after.Paused).toBe(false);
    expect(after.StartedAt).toBe(before.StartedAt);

    const meta = (row.meta ?? {}) as Record<string, unknown>;
    expect(meta.destructive).toBe(true);
    expect(meta.partialWrite).toBeUndefined();
    expect(meta.serviceLeftStopped).toBeUndefined();
  }, 900_000);

  it("leaves the database bit-for-bit unchanged when the restore FAILS", async () => {
    // The catalog's `restoreFailureLeavesTargetIntact`, end to end.
    //
    // The failure is engineered the way it happens in the field: something in the live
    // database depends on a table the archive also contains, so `--clean`'s
    // `DROP TABLE` cannot proceed. A view is the smallest such thing; a foreign key from
    // a table created later is the same shape.
    //
    // Before `--single-transaction`, THIS restore replaced the tables it could drop and
    // loaded the archive's rows on top of the ones it could not, leaving a database that
    // matched neither point in time and a run that said `errors ignored on restore: 3`.
    await sql(
      "DROP VIEW IF EXISTS atomic_guard; DROP TABLE IF EXISTS atomic_blocked, atomic_sibling; " +
        "CREATE TABLE atomic_sibling(id int); INSERT INTO atomic_sibling VALUES (1); " +
        "CREATE TABLE atomic_blocked(id int); INSERT INTO atomic_blocked VALUES (1)",
    );

    const { runId } = await capture("auto", {});

    // Diverge from the archive AFTER the capture, on the table whose drop will SUCCEED.
    // This row is the whole assertion: a restore that got as far as reloading
    // `atomic_sibling` and then hit the blocked drop would have deleted it. Its survival
    // is what "the transaction rolled back" means from the outside.
    await sql("INSERT INTO atomic_sibling VALUES (99)");
    await sql("CREATE VIEW atomic_guard AS SELECT * FROM atomic_blocked");

    const before = await containerState();
    const restoreId = await beginRestore(runId);
    const row = await waitForRestore(restoreId, "failed");

    expect(row.errorMessage ?? "").toContain("pg_restore exited");

    // The data. Both tables exactly as they were a moment ago, including the row the
    // archive has never heard of and the view that blocked the drop.
    expect(await sql("SELECT count(*) FROM atomic_sibling")).toBe("2");
    expect(await sql("SELECT count(*) FROM atomic_blocked")).toBe("1");
    expect(await sql("SELECT count(*) FROM pg_views WHERE viewname='atomic_guard'")).toBe("1");

    // And the REPORT. This is the suppression the catalog fact exists for: a run that
    // changed nothing must not tell the operator their data is partial, and a service
    // that was never stopped must not be reported as deliberately left down. Both used
    // to be stamped here, together, off "did we reach producer.restore".
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    expect(meta.partialWrite).toBeUndefined();
    expect(meta.serviceLeftStopped).toBeUndefined();
    // It DID begin writing, and that is still recorded — `destructive` is what the UI
    // uses to decide whether to warn at all, and the two facts are independent.
    expect(meta.destructive).toBe(true);
    expect(meta.destructiveSource).toBe('service "db" (pg_dump)');

    const after = await containerState();
    expect(after.Running).toBe(true);
    expect(after.StartedAt).toBe(before.StartedAt);
  }, 900_000);

  it("restores an archive whose GRANTs name a role the cluster no longer has", async () => {
    // `--no-acl`, and why it is required rather than incidental. `CREATE ROLE` is
    // cluster-global — `pg_dumpall --globals-only` territory — so a single-database
    // archive carries the GRANT and not the grantee. Restoring into a cluster without
    // that role is the disaster-recovery case, and under `--single-transaction` one
    // ignorable ACL error would abort everything and land nothing at all.
    await sql(
      "DROP TABLE IF EXISTS acl_rows; DROP ROLE IF EXISTS acl_reader; " +
        "CREATE TABLE acl_rows(id int); INSERT INTO acl_rows VALUES (1),(2),(3); " +
        "CREATE ROLE acl_reader NOLOGIN; GRANT SELECT ON acl_rows TO acl_reader",
    );

    const { runId } = await capture("auto", {});

    // The role disappears, the way it does when the cluster is new.
    await sql("DROP OWNED BY acl_reader; DROP ROLE acl_reader");
    await sql("DELETE FROM acl_rows");

    // Pin the premise, so this case cannot pass by the error not existing: the exact
    // statement the archive carries is a HARD error against this cluster right now.
    const probe = await execIn([
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "GRANT SELECT ON acl_rows TO acl_reader",
    ]);
    expect(probe.code).not.toBe(0);
    expect(probe.out).toContain("acl_reader");

    await restore(runId);

    expect(await sql("SELECT count(*) FROM acl_rows")).toBe("3");
    // Skipped, not invented. `--no-acl` declines to apply the privileges; it does not
    // create the missing role behind the operator's back.
    expect(await sql("SELECT count(*) FROM pg_roles WHERE rolname='acl_reader'")).toBe("0");
  }, 900_000);

  it("records the source run as restorable and the restore as its own row", async () => {
    // Cheap, and it closes the loop the UI actually reads: a restore points back at the
    // run it came from, and the run's own status is untouched by having been restored.
    // A restore that overwrote its source run's row would silently un-restorable it.
    const { runId } = await capture("auto", {});
    const row = await restore(runId);

    expect(row.runId).toBe(runId);
    expect((await repos.backupRun.findById(runId))?.status).toBe("succeeded");
    expect(row.bytesRestored).toBeGreaterThan(0);
  }, 900_000);
});
