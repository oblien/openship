import { beforeEach, describe, expect, it } from "vitest";
import { makeApp, seedOwner, seedServer, resetJobs, installFakeRunner, db, schema, repos, type SeededOwner } from "./_harness";
import { eq } from "@repo/db";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { jobRunBus } from "@repo/platform/engine/modules/jobs/job-run.sse";

const app = makeApp();
installFakeRunner();
beforeEach(resetJobs);

async function clients(owner: SeededOwner) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({
    user: { id: user.id, email: user.email, name: user.name }, sessionId: "sdk-job-test",
    credential: owner.auth && user.role !== "admin" ? { organizationId: owner.orgId, readOnly: false } : null,
  }) } });
  const native = await ship.scope({ identity: "verified", organizationId: owner.orgId });
  const remote = new OpenshipClient({ baseUrl: "http://openship.test", token: owner.token, fetch: ((url, init) => app.request(url as string, init)) as typeof fetch });
  return { native: native.jobs, remote: remote.jobs };
}

describe("jobs shared SDK/HTTP operations", () => {
  it("uses the same persisted schedule, secret masking and audit for both interfaces", async () => {
    const owner = await seedOwner();
    const serverId = await seedServer(owner.orgId);
    const { native, remote } = await clients(owner);
    const job = await remote.create({ label: "Backup", command: "printf ready", serverIds: [serverId], scheduleType: "manual", secrets: { TOKEN: "private-job-value" } });
    expect(await native.get(job.key)).toEqual(job);
    expect(job.actionConfig?.secrets).toEqual({ TOKEN: "" });
    const updated = await native.update(job.key, { label: "Renamed", scheduleType: "once", runAt: "2099-01-01T00:00:00Z" });
    expect(await remote.get(job.key)).toEqual(updated);
    expect(updated.nextRunAt).toBe("2099-01-01T00:00:00.000Z");
    expect(await native.triggerEvents()).toEqual(await remote.triggerEvents());
    await flushAudit();
    const audit = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.resourceId, job.key));
    expect(audit).toHaveLength(2);
    expect(audit.map(row => row.actorUserId)).toEqual([owner.userId, owner.userId]);
    expect(JSON.stringify(audit)).not.toContain("private-job-value");
    await native.remove(job.key);
    expect(await remote.list()).toEqual([]);
  });

  it("checks the stored and proposed targets without disclosing foreign jobs", async () => {
    const alice = await seedOwner(), bob = await seedOwner();
    const serverA = await seedServer(alice.orgId), serverB = await seedServer(bob.orgId);
    const a = await clients(alice), b = await clients(bob);
    const job = await a.native.create({ label: "Private", command: "printf private", serverIds: [serverA], scheduleType: "manual" });
    for (const client of [b.native, b.remote]) {
      expect(await client.list()).toEqual([]);
      for (const call of [() => client.get(job.key), () => client.update(job.key, { command: "changed" }), () => client.update(job.key, { serverIds: [serverB] }), () => client.remove(job.key), () => client.run(job.key)])
        await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND", message: "Job not found" });
    }
    await expect(a.native.update(job.key, { serverIds: [serverB] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await a.remote.get(job.key)).actionConfig?.command).toBe("printf private");
  });

  it("retains run target authority after config edits and deletion, including aggregate runs", async () => {
    const alice = await seedOwner(), bob = await seedOwner();
    const serverA = await seedServer(alice.orgId), serverA2 = await seedServer(alice.orgId), serverB = await seedServer(bob.orgId);
    const a = await clients(alice), b = await clients(bob);
    const job = await a.native.create({ label: "History", command: "printf private", serverIds: [serverA, serverA2], scheduleType: "manual" });
    const run = await repos.jobRun.start({ jobId: job.key, kind: "custom", serverIds: [serverA, serverA2] });
    await repos.jobRun.finish(run.id, { status: "success", output: "private run" });
    // Simulate a later administrator transfer; current config must not reassign old output.
    await repos.job.update(job.key, { actionConfig: { serverIds: [serverB], command: "printf moved" } });
    expect((await b.native.get(job.key)).recentRuns).toEqual([]);
    await expect(b.remote.getRun(run.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await b.native.remove(job.key);
    expect(await a.native.getRun(run.id)).toEqual(await a.remote.getRun(run.id));
    const events = [];
    for await (const event of a.native.streamRun(run.id)) events.push(JSON.parse(event.data));
    expect(events.map(event => event.type)).toEqual(["snapshot", "complete"]);
    await expect(b.native.getRun(run.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("conceals targetless jobs and legacy aggregate runs from organization owners", async () => {
    const owner = await seedOwner(), admin = await seedOwner({ instanceAdmin: true });
    const a = await clients(owner), root = await clients(admin);
    const job = await repos.job.create({ key: "custom:targetless", label: "Legacy", kind: "custom", actionType: "command", actionConfig: { command: "private" } });
    const run = await repos.jobRun.start({ jobId: job.key, kind: "custom" });
    for (const client of [a.native, a.remote]) {
      expect(await client.list()).toEqual([]);
      await expect(client.getRun(run.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.update(job.key, { label: "Changed" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect((await root.native.getRun(run.id)).id).toBe(run.id);
    expect((await root.remote.get(job.key)).label).toBe("Legacy");
  });

  it("refuses foreign dependency and notification channel references before persistence", async () => {
    const alice = await seedOwner(), bob = await seedOwner();
    const serverA = await seedServer(alice.orgId), serverB = await seedServer(bob.orgId);
    const a = await clients(alice), b = await clients(bob);
    const job = await b.native.create({ label: "Foreign", command: "true", serverIds: [serverB], scheduleType: "manual" });
    const channelId = `channel_${bob.userId}`;
    await db.insert(schema.notificationChannel).values({ id: channelId, userId: bob.userId, kind: "in_app", label: "Private" });
    for (const client of [a.native, a.remote]) {
      const input = { label: "No authority", command: "true", serverIds: [serverA], scheduleType: "manual" as const };
      await expect(client.create({ ...input, dependsOn: [job.key] })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.create({ ...input, notifyConfig: { channels: [channelId], states: ["success"] } })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await client.list()).toEqual([]);
    }
  });

  it("rechecks stream access when target ownership changes", async () => {
    const owner = await seedOwner(), other = await seedOwner();
    const serverId = await seedServer(owner.orgId);
    const { native } = await clients(owner);
    const run = await repos.jobRun.start({ jobId: "deleted-job", kind: "custom", serverIds: [serverId] });
    const stream = native.streamRun(run.id)[Symbol.asyncIterator]();
    expect((await stream.next()).value?.event).toBe("snapshot");
    await db.update(schema.servers).set({ organizationId: other.orgId }).where(eq(schema.servers.id, serverId));
    jobRunBus.publish(run.id, { type: "log", line: "private", level: "info" });
    await expect(stream.next()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await stream.return?.();
  });
});
