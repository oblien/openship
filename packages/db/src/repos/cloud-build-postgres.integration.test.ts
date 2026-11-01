/** Opt in with OPENSHIP_TEST_CLOUD_POSTGRES=1 bun run --cwd packages/db test
 * src/repos/cloud-build-postgres.integration.test.ts
 * Never uses DATABASE_URL/PG* credentials: owns a fresh /tmp cluster and stops it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool, type ClientConfig } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "../schema";
import { createEncryption } from "../encryption";
import { createAdvisoryLocks } from "../advisory-lock-factory";
import { createDeploymentRepo } from "./deployment.repo";
import { createCloudBuildActivityRepo } from "./cloud-build-activity.repo";
import { createCloudWorkspaceRepo } from "./cloud-workspace.repo";

const enabled = process.env.OPENSHIP_TEST_CLOUD_POSTGRES === "1";
const binaries = process.env.OPENSHIP_TEST_PG_BIN ?? "";
const binaryPath = `${binaries ? `${binaries}:` : ""}${process.env.PATH ?? "/usr/bin:/bin"}`;
const resources = { cpuCores: 1, memoryMb: 1024 };
const identity = (id: string) => ({
  deploymentId: `dep-${id}`,
  projectId: id,
  workspaceId: "w",
  organizationId: "org",
});
const claimInput = (id: string) => ({
  ...identity(id),
  buildSessionId: `session-${id}`,
  cloudBuildReservation: { workspaceId: "w", resources },
});
const exclusive = {
  id: "exclusive",
  controllerId: "test",
  scope: "server",
  startedAt: "2026-01-01T00:00:00.000Z",
};
const lockKey = "cloud:build-admission:w";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port allocated");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function replica(client: Client, config: ClientConfig, index: number) {
  const db = drizzle(client, { schema });
  const pool = new Pool({ ...config, application_name: `cloud-queue-lock-${index}`, max: 1 });
  const locks = createAdvisoryLocks({ getDriver: () => "pg", getPgPool: () => pool, poolMax: 2 });
  return {
    client,
    db,
    pool,
    locks,
    deployment: createDeploymentRepo(db, createEncryption("postgres-queue-test")),
    activity: createCloudBuildActivityRepo(db),
    workspace: createCloudWorkspaceRepo(db),
  };
}

// Independent pg clients are critical: PGlite serializes transactions internally
// and cannot establish either cross-replica admission or row-lock behavior.
describe.skipIf(!enabled)("isolated PostgreSQL Cloud build concurrency", () => {
  let root: string | undefined;
  let startAttempted = false;
  let observer: Client | undefined;
  const clients: Client[] = [];
  const replicas: ReturnType<typeof replica>[] = [];
  let backendPids: number[] = [];

  function pgCtl(args: string[]) {
    return execFileSync(join(binaries, "pg_ctl"), args, {
      env: { PATH: binaryPath, LC_ALL: "C" },
      encoding: "utf8",
      timeout: 20_000,
    });
  }

  beforeAll(async () => {
    root = mkdtempSync("/tmp/openship-cloud-queue-pg-");
    execFileSync(
      join(binaries, "initdb"),
      [
        "-D",
        join(root, "data"),
        "-U",
        "cloud_queue_test",
        "-A",
        "trust",
        "--no-locale",
        "--encoding=UTF8",
      ],
      {
        env: { PATH: binaryPath, LC_ALL: "C" },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    const port = await unusedPort();
    startAttempted = true;
    pgCtl([
      "-D",
      join(root, "data"),
      "-l",
      join(root, "postgres.log"),
      "-w",
      "-t",
      "15",
      "-o",
      `-h 127.0.0.1 -p ${port} -k ${root} -c deadlock_timeout=100ms -c log_lock_waits=on`,
      "start",
    ]);
    const config: ClientConfig = {
      host: "127.0.0.1",
      port,
      user: "cloud_queue_test",
      database: "postgres",
      password: "unused-test-password",
      ssl: false,
      connectionTimeoutMillis: 5000,
      options: "-c statement_timeout=8000 -c lock_timeout=5000",
    };
    observer = new Client({ ...config, application_name: "cloud-queue-observer" });
    await observer.connect();
    await migrate(drizzle(observer, { schema }), {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
    for (let index = 0; index < 2; index++) {
      const client = new Client({ ...config, application_name: `cloud-queue-replica-${index}` });
      clients.push(client);
      await client.connect();
      await client.query("SET session_replication_role = replica");
      replicas.push(replica(client, config, index));
      backendPids.push(Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
    }
    expect(backendPids[0]).not.toBe(backendPids[1]);
  });

  afterAll(async () => {
    try {
      await Promise.allSettled(replicas.map((item) => item.pool.end()));
      await Promise.allSettled(clients.map((client) => client.end()));
      await observer?.end();
    } finally {
      if (root) {
        // Address only the data directory this test created, even after setup or
        // assertion failure. Preserve its log if stopping fails for diagnosis.
        if (
          startAttempted &&
          pgCtl(["-D", join(root, "data"), "status"]).includes("server is running")
        ) {
          pgCtl(["-D", join(root, "data"), "-m", "immediate", "-w", "-t", "15", "stop"]);
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  async function fixtures() {
    const db = replicas[0].db;
    await db.delete(schema.cloudBuildActivity);
    await db.delete(schema.buildSession);
    await db.delete(schema.deployment);
    await db.delete(schema.project);
    await db.delete(schema.cloudDockerWorkspace);
    await db.delete(schema.cloudWorkspace);
    await db.insert(schema.cloudWorkspace).values({ id: "w", organizationId: "org", name: "Test" });
    await db.insert(schema.cloudDockerWorkspace).values({
      ownerWorkspaceId: "w",
      namespace: "test",
      provisionKey: "test",
      workspaceId: "test-vm",
      image: "test-image",
      resources: { cpuCores: 4, memoryMb: 8192, diskMb: 10000 },
      state: "ready",
    });
    for (const id of ["a", "b"]) {
      await db.insert(schema.project).values({
        id,
        organizationId: "org",
        groupId: `group-${id}`,
        workspaceId: "w",
        serverId: "test-server",
        name: id,
        slug: id,
      });
      await db.insert(schema.deployment).values({
        id: `dep-${id}`,
        projectId: id,
        organizationId: "org",
        branch: "main",
        status: "queued",
      });
      await db.insert(schema.buildSession).values({
        id: `session-${id}`,
        deploymentId: `dep-${id}`,
        projectId: id,
        status: "queued",
      });
      await replicas[0].deployment.requestCloudBuild(`dep-${id}`, "org");
    }
  }
  beforeEach(fixtures);

  async function waitForBlocked(pids: number[], waitEvent?: string) {
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      const result = await observer!.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
        WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'
          AND ($2::text IS NULL OR wait_event = $2)`,
        [pids, waitEvent ?? null],
      );
      if (result.rows.length === pids.length) return;
      await delay(10);
    }
    throw new Error(`Expected real PostgreSQL lock contention for backends ${pids.join(",")}`);
  }

  async function workspaceRace<T, U>(first: () => Promise<T>, second: () => Promise<U>) {
    await observer!.query("BEGIN");
    await observer!.query("SELECT id FROM cloud_workspace WHERE id = 'w' FOR UPDATE");
    // Attach rejection handlers immediately, including if an assertion fails
    // while another backend is waiting for the gate to open.
    const outcomes = Promise.allSettled([first(), second()]);
    try {
      await waitForBlocked(backendPids);
    } finally {
      await observer!.query("COMMIT");
    }
    return outcomes;
  }

  async function admit(index: number, id: string, afterCount?: () => Promise<void>) {
    const worker = replicas[index];
    return worker.locks.withAdvisoryLock(lockKey, async () => {
      const reservations = await worker.activity.listReservations("w", "org");
      const legacy = await worker.deployment.countActiveCloudBuilds("w", "org");
      await afterCount?.();
      if (legacy > 0 || reservations.filter((row) => row.resources !== null).length >= 1)
        return "waiting";
      const [head] = await worker.deployment.listRequestedCloudBuilds("w", 1);
      if (head?.id !== `dep-${id}`) return "waiting";
      return worker.deployment.claimBuildExecution(claimInput(id));
    });
  }

  it("serializes count + claim across replicas at cap one and reuses only released capacity", async () => {
    const counted = deferred();
    const continueClaim = deferred();
    const first = admit(0, "a", async () => {
      counted.resolve();
      await continueClaim.promise;
    });
    await counted.promise;
    const second = admit(1, "b");
    const outcomes = Promise.allSettled([first, second]);
    try {
      // Observe the real lock session, distinct from its replica query client.
      const deadline = Date.now() + 3500;
      let lockPid: number | undefined;
      while (!lockPid && Date.now() < deadline) {
        lockPid = (
          await observer!.query(
            "SELECT pid FROM pg_stat_activity WHERE application_name = 'cloud-queue-lock-1'",
          )
        ).rows[0]?.pid;
        if (!lockPid) await delay(10);
      }
      expect(lockPid).toBeDefined();
      await waitForBlocked([lockPid!], "advisory");
    } finally {
      continueClaim.resolve();
    }
    expect(await outcomes).toEqual([
      { status: "fulfilled", value: "claimed" },
      { status: "fulfilled", value: "waiting" },
    ]);
    expect(await replicas[1].activity.listReservations("w", "org")).toHaveLength(1);
    expect((await replicas[1].deployment.findBuildSession("session-b"))?.startedAt).toBeNull();
    expect(await replicas[1].deployment.countActiveCloudBuilds("w", "org")).toBe(0);
    await replicas[0].activity.claim(identity("a"), "owner-a");
    await replicas[0].activity.releaseSlot(identity("a"), "owner-a");
    expect((await replicas[1].deployment.findBuildSession("session-a"))?.finishedAt).toBeNull();
    expect(await admit(1, "b")).toBe("claimed");
    expect(await replicas[1].activity.listReservations("w", "org")).toHaveLength(1);
  });

  it("allows only one winner in shared-build versus exclusive-lifecycle row-lock races", async () => {
    for (let iteration = 0; iteration < 12; iteration++) {
      if (iteration) await fixtures();
      const shared = () =>
        replicas[iteration % 2].activity.claim(identity("a"), `owner-${iteration}`);
      const lifecycle = () =>
        replicas[1 - (iteration % 2)].workspace.claimActivity("w", "org", exclusive);
      const results = await workspaceRace(shared, lifecycle);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const failure = results.find((result) => result.status === "rejected");
      expect(failure).toMatchObject({ reason: { code: "CLOUD_WORKSPACE_ACTIVITY_BUSY" } });
    }
  });

  it("reservation/deployment claims and activity activation contend without transaction deadlocks", async () => {
    for (let iteration = 0; iteration < 12; iteration++) {
      if (iteration) await fixtures();
      await replicas[0].activity.reserve({
        ...identity("a"),
        resources,
        buildSessionId: "session-a",
      });
      const results = await workspaceRace(
        () => replicas[0].deployment.claimBuildExecution(claimInput("a")),
        () => replicas[1].activity.claim(identity("a"), `owner-${iteration}`),
      );
      expect(results[0]).toEqual({ status: "fulfilled", value: "claimed" });
      expect(results[1]).toMatchObject({
        status: "fulfilled",
        value: { ownerToken: `owner-${iteration}` },
      });
      expect(await replicas[0].activity.listReservations("w", "org")).toHaveLength(1);
    }
    await observer!.query("SELECT pg_stat_clear_snapshot()");
    const { rows } = await observer!.query(
      "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()",
    );
    expect(Number(rows[0].deadlocks)).toBe(0);
    expect(readFileSync(join(root!, "postgres.log"), "utf8")).not.toContain("deadlock detected");
  });

  it.each(["deferral", "activation"] as const)(
    "keeps deferral versus activation safe when %s owns execution first",
    async (first) => {
      await replicas[0].deployment.claimBuildExecution(claimInput("a"));
      const deferredInput = { ...identity("a"), buildSessionId: "session-a" };
      const defer = () => replicas[0].deployment.deferUnactivatedCloudBuild(deferredInput);
      const activate = async () => {
        // The pipeline re-reads status immediately after execution ownership,
        // before entering the wrapper. Raw claim supports legacy direct callers
        // and is deliberately not the complete worker admission protocol.
        const current = await replicas[1].deployment.findById("dep-a");
        if (!current || !["building", "deploying"].includes(current.status)) return "state_changed";
        return replicas[1].activity.claim(identity("a"), "racing-owner");
      };
      const firstIndex = first === "deferral" ? 0 : 1;
      const secondIndex = 1 - firstIndex;
      const ownsExecution = deferred();
      const continueOwner = deferred();
      const executionKey = "cloud:build-execution:dep-a";
      const firstResult = replicas[firstIndex].locks.withAdvisoryLock(executionKey, async () => {
        ownsExecution.resolve();
        await continueOwner.promise;
        return first === "deferral" ? defer() : activate();
      });
      await ownsExecution.promise;
      const secondResult = replicas[secondIndex].locks.withAdvisoryLock(executionKey, async () =>
        first === "deferral" ? activate() : defer(),
      );
      const outcomes = Promise.allSettled([firstResult, secondResult]);
      try {
        const deadline = Date.now() + 3500;
        let pid: number | undefined;
        while (!pid && Date.now() < deadline) {
          pid = (
            await observer!.query("SELECT pid FROM pg_stat_activity WHERE application_name = $1", [
              `cloud-queue-lock-${secondIndex}`,
            ])
          ).rows[0]?.pid;
          if (!pid) await delay(10);
        }
        expect(pid).toBeDefined();
        await waitForBlocked([pid!], "advisory");
      } finally {
        continueOwner.resolve();
      }
      const [leading, trailing] = await outcomes;
      const deployment = await replicas[0].deployment.findById("dep-a");
      const session = await replicas[0].deployment.findBuildSession("session-a");
      const activity = await replicas[0].activity.find(identity("a"));
      if (first === "deferral") {
        expect(leading).toEqual({ status: "fulfilled", value: true });
        expect(trailing).toEqual({ status: "fulfilled", value: "state_changed" });
        expect(deployment?.status).toBe("queued");
        expect(session).toMatchObject({ status: "queued", startedAt: null, finishedAt: null });
        expect(activity).toBeUndefined();
      } else {
        expect(leading).toMatchObject({
          status: "fulfilled",
          value: { ownerToken: "racing-owner" },
        });
        expect(trailing).toEqual({ status: "fulfilled", value: false });
        expect(deployment?.status).toBe("building");
        expect(session).toMatchObject({
          status: "building",
          startedAt: expect.any(Date),
          finishedAt: null,
        });
        expect(activity).toMatchObject({ ownerToken: "racing-owner", finishedAt: null });
      }
      const unsafe = await observer!
        .query(`SELECT d.id FROM deployment d JOIN cloud_build_activity a ON a.deployment_id = d.id
      WHERE d.status = 'queued' AND a.owner_token IS NOT NULL AND a.finished_at IS NULL`);
      expect(unsafe.rows).toEqual([]);
      expect(readFileSync(join(root!, "postgres.log"), "utf8")).not.toContain("deadlock detected");
    },
  );
});
