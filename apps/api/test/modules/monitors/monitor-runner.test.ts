/**
 * Monitor runner — threshold state machine unit tests + one real probe loop.
 *
 * evaluateTransition is pure, so the down/recovered rules are asserted
 * directly. The integration test runs runMonitorChecks() (the tick app.ts's
 * interval fires) against a real node:http server: up → check row + status
 * "up"; server killed → status "down" + incident + a queued
 * notification_delivery (a verified in_app channel is subscribed to
 * monitor.down); server back → status "up" + incident resolved.
 */
import "./_env";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "@repo/db";
import { db, schema, repos, seedOwner, seedProject } from "./_harness";
import { evaluateTransition, runMonitorChecks } from "../../../src/lib/monitor-runner";

describe("evaluateTransition", () => {
  it("keeps status on a failure streak below the threshold", () => {
    expect(
      evaluateTransition({ status: "up", consecutiveFailures: 1, failureThreshold: 3 }, false),
    ).toEqual({ status: "up", consecutiveFailures: 2, wentDown: false, recovered: false });
  });

  it("flips to down exactly when the streak reaches the threshold", () => {
    expect(
      evaluateTransition({ status: "up", consecutiveFailures: 2, failureThreshold: 3 }, false),
    ).toEqual({ status: "down", consecutiveFailures: 3, wentDown: true, recovered: false });
  });

  it("never re-alerts while already down", () => {
    expect(
      evaluateTransition({ status: "down", consecutiveFailures: 5, failureThreshold: 3 }, false),
    ).toEqual({ status: "down", consecutiveFailures: 6, wentDown: false, recovered: false });
  });

  it("recovers a down monitor on the first success and resets the streak", () => {
    expect(
      evaluateTransition({ status: "down", consecutiveFailures: 6, failureThreshold: 3 }, true),
    ).toEqual({ status: "up", consecutiveFailures: 0, wentDown: false, recovered: true });
  });

  it("a success while up resets the streak without a recovery transition", () => {
    expect(
      evaluateTransition({ status: "up", consecutiveFailures: 2, failureThreshold: 3 }, true),
    ).toEqual({ status: "up", consecutiveFailures: 0, wentDown: false, recovered: false });
  });
});

describe("runMonitorChecks (integration)", () => {
  let server: Server | null = null;

  const listen = (port = 0): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((_req, res) => res.writeHead(200).end("ok"));
      server.listen(port, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
    });
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server ? server.close(() => resolve()) : resolve();
      server = null;
    });

  /** claimDue only picks stale monitors — age the row so the next tick re-probes. */
  const makeDueAgain = async (monitorId: string) => {
    await db
      .update(schema.monitor)
      .set({ lastCheckedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(schema.monitor.id, monitorId));
  };

  /** notification.emit dispatches fire-and-forget — poll for the delivery row. */
  const waitForDelivery = async (userId: string, orgId: string) => {
    for (let i = 0; i < 40; i++) {
      const rows = await repos.notificationDelivery.listForUser(userId, orgId);
      if (rows.length > 0) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return repos.notificationDelivery.listForUser(userId, orgId);
  };

  afterEach(async () => {
    await close();
  });

  it("probes a live server, opens an incident on death, resolves on recovery", async () => {
    const o = await seedOwner();
    const projectId = await seedProject(o.orgId);
    const port = await listen();

    // In-app channel subscribed to monitor.down — dispatch skips unverified
    // channels, so mark it verified directly.
    const now = new Date();
    const channelId = `nch_test_${port}`;
    await db.insert(schema.notificationChannel).values({
      id: channelId,
      userId: o.userId,
      kind: "in_app",
      label: "bell",
      config: {},
      verified: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.notificationSubscription).values({
      id: `nsb_test_${port}`,
      userId: o.userId,
      organizationId: o.orgId,
      category: "monitor.down",
      channelId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });

    const mon = await repos.monitor.create({
      organizationId: o.orgId,
      projectId,
      createdBy: o.userId,
      name: "local probe",
      url: `http://127.0.0.1:${port}/`,
      intervalSeconds: 30,
      timeoutMs: 2000,
      expectedStatus: null,
      failureThreshold: 1,
      enabled: true,
    });

    // Tick 1: server up → check row + status "up"
    await runMonitorChecks();
    let row = await repos.monitor.findById(mon.id);
    expect(row?.status).toBe("up");
    expect(row?.consecutiveFailures).toBe(0);
    expect(row?.lastStatusCode).toBe(200);
    const checks = await repos.monitorCheck.listRecent(mon.id);
    expect(checks.length).toBe(1);
    expect(checks[0].ok).toBe(true);

    // Tick 2: server dead → threshold 1 crossed → down + incident + alert
    await close();
    await makeDueAgain(mon.id);
    await runMonitorChecks();
    row = await repos.monitor.findById(mon.id);
    expect(row?.status).toBe("down");
    expect(row?.consecutiveFailures).toBe(1);
    const incident = await repos.monitorIncident.findOpen(mon.id);
    expect(incident).toBeDefined();
    expect(incident?.error).toBeTruthy();
    const deliveries = await waitForDelivery(o.userId, o.orgId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe("queued");
    expect(deliveries[0].category).toBe("monitor.down");
    expect(deliveries[0].payload).toMatchObject({
      eventType: "monitor.down",
      resourceType: "monitor",
      resourceId: mon.id,
      monitorName: "local probe",
    });

    // Tick 3: server back on the same port → recovered + incident resolved
    await listen(port);
    await makeDueAgain(mon.id);
    await runMonitorChecks();
    row = await repos.monitor.findById(mon.id);
    expect(row?.status).toBe("up");
    expect(row?.consecutiveFailures).toBe(0);
    expect(await repos.monitorIncident.findOpen(mon.id)).toBeUndefined();
    const [resolved] = await repos.monitorIncident.listByMonitor(mon.id);
    expect(resolved.resolvedAt).not.toBeNull();
  });
});
