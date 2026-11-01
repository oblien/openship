import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { initPlatform, resetPlatform } from "@repo/adapters";
import { OpenshipClient } from "@repo/sdk/client";
import { makeApp, seedOwner, seedServer, resetJobs, installFakeRunner, repos } from "../jobs/_harness";
import { issuesRoutes } from "../../../src/modules/issues/issues.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";

const h = vi.hoisted(() => ({
  offline: false,
  fail: false,
  failureReason: "Cannot reach the SSH server: Timed out while waiting for handshake",
  reads: vi.fn(),
  dispose: vi.fn(),
  notify: vi.fn(),
  projectId: "",
  gate: null as Promise<void> | null,
}));
vi.mock("@repo/platform/engine/lib/desktop-network", () => ({ desktopNetworkDisconnected: () => h.offline }));
vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({ notification: { emit: h.notify } }));
vi.mock("@repo/platform/engine/modules/monitoring/container-events", () => ({
  renewEventWatchers: vi.fn(), stopAllContainerEventWatchers: vi.fn(),
}));
// Only the remote transport is simulated. HTTP auth, SDK request/response codecs, the shared
// scanner, job recording, incident persistence and aggregation are production code.
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...await original<object>(),
  resolveDeploymentRuntimeForRead: async () => ({
    runtime: {
      supports: (capability: string) => capability === "hostContainerQuery",
      listAllContainers: async () => {
        h.reads();
        if (h.gate) await h.gate;
        if (h.fail) throw new Error(h.failureReason);
        return [{ id: "observed-container", names: ["/observed-container"], state: "running", status: "Up", labels: { "openship.project": h.projectId } }];
      },
      dispose: h.dispose,
    },
  }),
}));

const app = makeApp().route("/api/health", healthRoutes).route("/api/issues", issuesRoutes);
installFakeRunner();
beforeAll(async () => {
  await initPlatform({ target: "desktop", runtime: "bare" });
  await resetJobs();
  await repos.job.upsertSystem({ key: "services:health-watch", label: "Container health", defaultCron: "* * * * *" });
});
afterAll(() => resetPlatform());

describe("desktop monitoring recovery through HTTP and the SDK", () => {
  it("keeps disconnection separate from server failure and reconciles the persisted incident on recheck", async () => {
    const owner = await seedOwner({ instanceAdmin: true });
    const serverId = await seedServer(owner.orgId);
    await repos.serverContainerStatus.upsert({
      serverId, organizationId: owner.orgId, component: "edge", behind: false, detail: { down: false },
    });
    const group = await repos.projectGroup.create({ name: "Monitored app", slug: "monitored", organizationId: owner.orgId });
    const project = await repos.project.create({ name: "Monitored app", slug: "monitored", groupId: group.id, organizationId: owner.orgId });
    h.projectId = project.id;
    const old = new Date(Date.now() - 30 * 60_000);
    const deployment = (await repos.deployment.create({
      projectId: project.id, organizationId: owner.orgId, branch: "main", status: "ready",
      containerId: "observed-container", meta: { serverId, runtimeMode: "docker" },
      createdAt: old, updatedAt: old,
    }))!;
    await repos.project.setActiveDeployment(project.id, deployment.id);
    const client = new OpenshipClient({
      baseUrl: "http://openship.test", token: owner.token, organizationId: owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    });

    const finishScan = async () => {
      let completed = (await client.issues.rescanStatus())!;
      await vi.waitFor(async () => {
        completed = (await client.issues.rescanStatus())!;
        expect(completed.status).toBe("completed");
      }, { timeout: 5000, interval: 10 });
      expect(completed.stages.filter(stage => stage.status !== "skipped").map(stage => stage.key)).toEqual(["services:health-watch"]);
      expect(completed.stages[0]!.status).toBe("completed");
      return completed.stages[0]!.summary;
    };
    const scan = async () => {
      await client.issues.rescan({ healthOnly: true });
      return finishScan();
    };

    h.offline = true;
    expect(await scan()).toMatchObject({ offline: 1, unreachable: 0 });
    expect(h.reads).not.toHaveBeenCalled();
    const offline = await client.issues.list();
    expect(offline.issues.map(issue => issue.kind)).toEqual(["monitoring_offline"]);
    expect(offline.counts.outage).toBe(0);
    expect(await repos.serviceIncident.findOpenForServer(serverId)).toBeUndefined();

    h.offline = false;
    // A live network interface does not establish a route. Exercise the actual
    // serialized SSH/Docker error through persistence, HTTP and the SDK too.
    h.fail = true;
    h.failureReason = "(HTTP code 502) unexpected - Could not reach Docker over SSH: connect ENETUNREACH 192.0.2.1:22 - Local (0.0.0.0:63263)";
    expect(await scan()).toMatchObject({ offline: 1, unreachable: 0, opened: 1 });
    const connection = await client.issues.list();
    expect(connection.issues).toMatchObject([{
      kind: "monitoring_offline", severity: "action_required",
      details: { affectedServers: [{ id: serverId }] }, resolveWith: [],
    }]);
    expect(connection.counts).toMatchObject({ outage: 0, actionRequired: 1, total: 1 });
    expect(await repos.serviceIncident.findOpenForServer(serverId)).toMatchObject({ notifiedAt: null });
    expect(h.notify).not.toHaveBeenCalled();

    h.fail = false;
    expect(await scan()).toMatchObject({ offline: 0, unreachable: 0, resolved: 1 });
    expect(await repos.serviceIncident.findOpenForServer(serverId)).toBeUndefined();
    expect((await client.issues.list()).issues).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();

    // Keep job scheduling real while advancing only the observation clock. A
    // single missed probe is pending; a later agreeing scan confirms the outage.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    onTestFinished(() => vi.useRealTimers());
    h.fail = true;
    h.failureReason = "Cannot reach the SSH server: Timed out while waiting for handshake";
    expect(await scan()).toMatchObject({ offline: 0, unreachable: 1, opened: 0, pending: 1 });
    expect(await repos.serviceIncident.findOpenForServer(serverId)).toBeUndefined();
    expect((await client.issues.list()).issues).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 5_000);
    expect(await scan()).toMatchObject({ offline: 0, unreachable: 1, opened: 1, pending: 0 });
    const failure = await client.issues.list();
    expect(failure.issues).toMatchObject([{ kind: "server_unreachable", severity: "action_required" }]);
    expect(await repos.serviceIncident.findOpenForServer(serverId)).toBeDefined();
    expect(h.notify.mock.calls.map(([event]) => event.eventType)).toEqual(["server.unreachable"]);

    h.fail = false;
    let release!: () => void;
    h.gate = new Promise<void>(resolve => { release = resolve; });
    const accepted = await client.issues.rescan({ healthOnly: true });
    await vi.waitFor(() => expect(h.reads).toHaveBeenCalledTimes(5));
    try {
      // Older SDKs send Content-Type: application/json with no body. Keep that
      // valid, and attach concurrent callers to the existing scanner admission.
      const duplicate = await app.request("/api/issues/rescan", {
        method: "POST", headers: { ...owner.auth, "Content-Type": "application/json" },
      });
      expect(duplicate.status).toBe(202);
      expect((await duplicate.json()).data.id).toBe(accepted.id);
    } finally {
      release();
      h.gate = null;
    }
    expect(await finishScan()).toMatchObject({ unreachable: 0, resolved: 1 });
    expect(await repos.serviceIncident.findOpenForServer(serverId)).toBeUndefined();
    expect((await client.issues.list()).issues).toEqual([]);
    expect((await client.issues.list({ status: "resolved" })).issues).toMatchObject([
      { kind: "server_unreachable", resolvedAt: expect.any(String) },
      { kind: "server_unreachable", resolvedAt: expect.any(String) },
    ]);
    expect(h.notify.mock.calls.map(([event]) => event.eventType)).toEqual(["server.unreachable", "server.reachable"]);
    expect(h.reads).toHaveBeenCalledTimes(5);
    expect(h.dispose).toHaveBeenCalledTimes(5);
  });

  it("retains instance authority for health-only scans", async () => {
    const owner = await seedOwner();
    const response = await app.request("/api/issues/rescan", {
      method: "POST", headers: { ...owner.auth, "Content-Type": "application/json" }, body: JSON.stringify({ healthOnly: true }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects malformed options instead of falling back to a full scan", async () => {
    const owner = await seedOwner({ instanceAdmin: true });
    for (const body of ['{"healthOnly":', '{"healthOnly":"true"}']) {
      const response = await app.request("/api/issues/rescan", {
        method: "POST", headers: { ...owner.auth, "Content-Type": "application/json" }, body,
      });
      expect(response.status).toBe(400);
    }
  });
});
