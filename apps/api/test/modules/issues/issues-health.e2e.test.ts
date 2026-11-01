import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initPlatform, resetPlatform } from "@repo/adapters";
import { makeApp, seedOwner, resetJobs, installFakeRunner, repos, req } from "../jobs/_harness";
import { issuesRoutes } from "../../../src/modules/issues/issues.routes";
import * as containerEvents from "@repo/platform/engine/modules/monitoring/container-events";
import { reconcileJobs } from "@repo/platform/engine/modules/jobs/job.service";

const app = makeApp().route("/api/issues", issuesRoutes);
const runner = installFakeRunner();

beforeEach(async () => {
  await initPlatform({ target: "desktop", runtime: "bare" });
  await resetJobs();
  runner.recurring.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => resetPlatform());

describe("health monitoring capabilities at the HTTP boundary", () => {
  it("reports automatic monitoring enabled by default after desktop startup", async () => {
    const admin = await seedOwner({ instanceAdmin: true });
    await reconcileJobs();
    const response = await app.request("/api/issues/health", { headers: admin.auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [],
      watching: true,
      capabilities: { current: true, continuous: true },
      watcher: {
        key: "services:health-watch",
        available: true,
        canManage: true,
        runsWhileAppOpen: true,
        eventsEnabled: true,
      },
    });
    expect((await repos.job.findByKey("services:health-watch"))?.enabled).toBe(true);
    expect(runner.recurring.has("services:health-watch")).toBe(true);
  });

  it("lets an organization owner read health without offering instance-wide controls", async () => {
    const owner = await seedOwner();
    const response = await app.request("/api/issues/health", { headers: owner.auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ watcher: { canManage: false } });
    expect(
      (
        await req(app, "PATCH", "/services%3Ahealth-watch", {
          auth: owner.auth,
          body: { enabled: true },
        })
      ).status,
    ).toBe(403);
    expect(await repos.job.findByKey("services:health-watch")).toBeNull();
  });

  it("reports the saved watcher state and releases event subscriptions when paused", async () => {
    const admin = await seedOwner({ instanceAdmin: true });
    await req(app, "PATCH", "/services%3Ahealth-watch", {
      auth: admin.auth,
      body: { enabled: true },
    });
    const response = await app.request("/api/issues/health", { headers: admin.auth });
    expect(await response.json()).toMatchObject({ watching: true, watcher: { canManage: true } });
    const stopEvents = vi.spyOn(containerEvents, "stopAllContainerEventWatchers");
    await req(app, "PATCH", "/services%3Ahealth-watch", {
      auth: admin.auth,
      body: { enabled: false },
    });
    const paused = await app.request("/api/issues/health", { headers: admin.auth });
    expect(await paused.json()).toMatchObject({
      watching: false,
      watcher: { eventsEnabled: false },
    });
    expect(runner.recurring.has("services:health-watch")).toBe(false);
    expect(stopEvents).toHaveBeenCalledOnce();
  });

  it("never advertises a running monitor when native background jobs are disabled", async () => {
    const admin = await seedOwner({ instanceAdmin: true });
    await repos.job.upsertSystem({
      key: "services:health-watch",
      label: "Health",
      defaultCron: "* * * * *",
    });
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_JOBS", "false");
    await reconcileJobs();
    const response = await app.request("/api/issues/health", { headers: admin.auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      watching: false,
      capabilities: { continuous: false },
      watcher: { available: false, canManage: false, eventsEnabled: false },
    });
    expect(runner.recurring.has("services:health-watch")).toBe(false);
  });

  it("supports shared managed-server health reads, scans and watcher activation", async () => {
    const admin = await seedOwner({ instanceAdmin: true });
    await repos.job.upsertSystem({
      key: "services:health-watch",
      label: "Health",
      defaultCron: "* * * * *",
    });
    await initPlatform({ target: "cloud", runtime: "cloud" });
    await reconcileJobs();
    for (const [path, method] of [
      ["/api/issues/health", "GET"],
      ["/api/issues/health/scan", "POST"],
    ]) {
      const response = await app.request(path, { method, headers: admin.auth });
      expect(response.status).toBe(200);
    }
    expect(
      (
        await req(app, "PATCH", "/services%3Ahealth-watch", {
          auth: admin.auth,
          body: { enabled: true },
        })
      ).status,
    ).toBe(200);
    expect(runner.recurring.has("services:health-watch")).toBe(true);
  });
});
