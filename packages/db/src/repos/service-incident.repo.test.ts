import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createServiceIncidentRepo, incidentSeverity } from "./service-incident.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Real (in-memory PGlite) tests, because the behaviour that matters here is
 * enforced by the DATABASE, not by this file.
 *
 * "We are already alerting about this" is a partial unique index, deliberately:
 * the health watch runs on a cron AND has a Run-now button, so two ticks can
 * overlap, and the noise guarantee (one message per fault) would otherwise rest on
 * two sweeps not racing. A mock would happily let both insert. So would a plain
 * `insert`, which is why `open()` uses `onConflictDoNothing` and returns undefined
 * for the loser — a caller that treats "not mine" as "opened" double-notifies.
 *
 * Two indexes exist because Postgres treats NULLs as distinct: server-scoped rows
 * carry `project_id IS NULL` and need their own uniqueness rule, or one unplugged
 * cable pages once per tick forever.
 *
 * Running the real migrations also asserts 0083 applies forward.
 */
async function freshRepo() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;"); // skip org/project FK seeding
  return createServiceIncidentRepo(db);
}

const workload = {
  organizationId: "org-1",
  projectId: "proj-1",
  serviceId: null,
  serviceKey: "svc-web",
  serviceName: "web",
  serverId: "srv-1",
  containerId: "abc123456789",
  kind: "down" as const,
};

describe("serviceIncident repo", () => {
  it("opens one incident and reads it back as the workload's open incident", async () => {
    const repo = await freshRepo();
    const incident = await repo.open({ ...workload, reason: "it exited with code 1", confirmations: 1 });

    expect(incident).toBeDefined();
    expect(incident?.status).toBe("open");
    expect(incident?.notifyCount).toBe(0);
    expect(await repo.findOpen("proj-1", "svc-web")).toMatchObject({ id: incident!.id });
  });

  it("refuses a second open incident for the same workload", async () => {
    const repo = await freshRepo();
    const first = await repo.open({ ...workload, confirmations: 1 });
    // The concurrent tick. Undefined, not a throw and not a duplicate row — the
    // caller reads that as "somebody else opened it, not mine to notify about".
    const second = await repo.open({ ...workload, kind: "crash_loop", confirmations: 1 });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(await repo.listForProject("proj-1")).toHaveLength(1);
  });

  it("allows a new incident for the same workload once the old one is resolved", async () => {
    const repo = await freshRepo();
    const first = await repo.open({ ...workload, confirmations: 1 });
    expect(await repo.resolve(first!.id)).toBe(true);

    const second = await repo.open({ ...workload, confirmations: 1 });
    expect(second).toBeDefined();
    expect(second!.id).not.toBe(first!.id);
    expect(await repo.listForProject("proj-1")).toHaveLength(2);
    expect(await repo.findOpen("proj-1", "svc-web")).toMatchObject({ id: second!.id });
  });

  it("keeps different workloads in the same project independent", async () => {
    const repo = await freshRepo();
    expect(await repo.open({ ...workload, confirmations: 1 })).toBeDefined();
    expect(await repo.open({ ...workload, serviceKey: "svc-db", serviceName: "db" })).toBeDefined();

    const open = await repo.listOpen();
    expect(open.map((r) => r.serviceKey).sort()).toEqual(["svc-db", "svc-web"]);
  });

  it("refuses a second open SERVER incident for the same box", async () => {
    const repo = await freshRepo();
    const server = {
      organizationId: "org-1",
      projectId: null,
      serviceId: null,
      serviceKey: "server:srv-1",
      serviceName: "box-1",
      serverId: "srv-1",
      kind: "server_unreachable" as const,
    };

    expect(await repo.open(server)).toBeDefined();
    expect(await repo.open(server)).toBeUndefined();
    expect(await repo.findOpenForServer("srv-1")).toBeDefined();
    // Server-scoped rows never appear in the project sweep's open set.
    expect(await repo.listOpen()).toHaveLength(0);
  });

  it("resolves exactly once, so only one recovery notification can fire", async () => {
    const repo = await freshRepo();
    const incident = await repo.open({ ...workload, confirmations: 1 });

    expect(await repo.resolve(incident!.id)).toBe(true);
    // The second concurrent resolver learns it lost and stays quiet.
    expect(await repo.resolve(incident!.id)).toBe(false);
    expect(await repo.findOpen("proj-1", "svc-web")).toBeUndefined();
  });

  it("touch refreshes the observation without touching notify bookkeeping", async () => {
    const repo = await freshRepo();
    const incident = await repo.open({ ...workload, confirmations: 1 });
    await repo.markNotified(incident!.id);

    // Neither caller passes a count: both would have read `confirmations: 1` off the same
    // snapshot and computed the same next value, losing one of the two observations.
    await repo.touch(incident!.id, { reason: "still down", restartCount: 12 });
    await repo.touch(incident!.id, { reason: "still down", restartCount: 12 });
    const [row] = await repo.listForProject("proj-1");

    // Three ticks of a multi-hour outage; still one message sent. This is the branch
    // that makes the alert volume bounded.
    expect(row).toMatchObject({ reason: "still down", restartCount: 12, confirmations: 3 });
    expect(row?.notifyCount).toBe(1);
    expect(row?.kind).toBe("down");
    expect(row?.notifiedAt).toBeInstanceOf(Date);
  });

  it("touch leaves a resolved incident alone", async () => {
    const repo = await freshRepo();
    const incident = await repo.open({ ...workload, confirmations: 1 });
    await repo.resolve(incident!.id);

    await repo.touch(incident!.id, { reason: "still down" });
    const [row] = await repo.listForProject("proj-1");

    // A closed incident is not still being observed — a late tick must not revive its
    // detail or its count, or the Health tab shows an outage that ended as ongoing.
    expect(row).toMatchObject({ status: "resolved", confirmations: 1 });
    expect(row?.reason).not.toBe("still down");
  });

  it("escalates exactly once, so only one escalation notification can fire", async () => {
    const repo = await freshRepo();
    const incident = await repo.open({ ...workload, kind: "unhealthy", confirmations: 2 });

    expect(
      await repo.escalate(incident!.id, "unhealthy", "down", {
        reason: "it exited with code 137",
        exitCode: 137,
      }),
    ).toBe(true);
    // The second poller decided the same promotion off the same snapshot. It learns the
    // row already moved and stays quiet instead of paging about it again.
    expect(
      await repo.escalate(incident!.id, "unhealthy", "down", {
        reason: "it exited with code 1",
        exitCode: 1,
      }),
    ).toBe(false);

    const [row] = await repo.listForProject("proj-1");
    expect(row).toMatchObject({ kind: "down", exitCode: 137, status: "open" });
  });

  it("never escalates a closed incident", async () => {
    const repo = await freshRepo();
    const incident = await repo.open({ ...workload, kind: "unhealthy", confirmations: 1 });
    await repo.resolve(incident!.id);

    expect(await repo.escalate(incident!.id, "unhealthy", "down")).toBe(false);
    const [row] = await repo.listForProject("proj-1");
    expect(row).toMatchObject({ kind: "unhealthy", status: "resolved" });
  });

  it("prunes resolved history past the cutoff and never an open incident", async () => {
    const repo = await freshRepo();
    const old = await repo.open({ ...workload, confirmations: 1 });
    await repo.resolve(old!.id, new Date(Date.now() - 60 * 24 * 60 * 60 * 1000));
    const recent = await repo.open({ ...workload, serviceKey: "svc-db", serviceName: "db" });
    await repo.resolve(recent!.id);
    const live = await repo.open({ ...workload, serviceKey: "svc-cache", serviceName: "cache" });

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(await repo.deleteResolvedOlderThan(cutoff)).toBe(1);

    const remaining = (await repo.listForProject("proj-1")).map((r) => r.id);
    expect(remaining).toContain(recent!.id);
    expect(remaining).toContain(live!.id);
    expect(remaining).not.toContain(old!.id);
  });

  it("orders severity so an incident escalates upward only", async () => {
    expect(incidentSeverity("unhealthy")).toBeLessThan(incidentSeverity("crash_loop"));
    expect(incidentSeverity("crash_loop")).toBeLessThan(incidentSeverity("down"));
    // An unreachable box is as bad as a down service, and neither escalates to the
    // other — a workload incident must never be re-announced as a server one.
    expect(incidentSeverity("server_unreachable")).toBe(incidentSeverity("down"));
  });
});
