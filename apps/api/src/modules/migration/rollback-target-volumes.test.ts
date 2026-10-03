import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";

const h = vi.hoisted(() => ({
  runtime: vi.fn(), activity: vi.fn(), tryLock: vi.fn(), plan: vi.fn(),
  prepare: vi.fn(), transfer: vi.fn(), cancelBuild: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/migration/migration-runtime", async load => ({
  ...await load<typeof import("@repo/platform/engine/modules/migration/migration-runtime")>(),
  createMigrationDockerRuntime: h.runtime, withMigrationActivity: h.activity,
}));
vi.mock("@repo/platform/engine/modules/migration/migration-access", () => ({
  assertMigrationEndpoints: async () => ({ source: {}, target: {} }),
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-lock", () => ({
  withCloudWorkspaceActivity: (_id: unknown, work: () => Promise<unknown>) => work(),
}));
vi.mock("@repo/platform/engine/lib/provision-lock", async load => ({
  ...await load<typeof import("@repo/platform/engine/lib/provision-lock")>(),
  createProvisionLock: () => ({ run: (work: () => Promise<unknown>) => work() }),
  tryWithProvisionLock: h.tryLock,
}));
vi.mock("@repo/platform/engine/modules/migration/migration-data", async load => ({
  ...await load<typeof import("@repo/platform/engine/modules/migration/migration-data")>(),
  planMigrationData: h.plan, prepareMigrationVolumes: h.prepare, transferMigrationItem: h.transfer,
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", async load => ({
  ...await load<typeof import("@repo/platform/engine/modules/deployments/build.service")>(),
  cancelBuildSession: h.cancelBuild,
}));

import { migrationOrchestrator } from "@repo/platform/engine/modules/migration/migration.orchestrator";
type Run = NonNullable<Awaited<ReturnType<typeof repos.dockerMigrationRun.findById>>>;
const engine = migrationOrchestrator as unknown as {
  moveData: (...args: unknown[]) => Promise<unknown>;
  rollback: (...args: unknown[]) => Promise<void>;
  restartSourceOriginals: (...args: unknown[]) => Promise<void>;
  restoreTargetContainers: (...args: unknown[]) => Promise<void>;
  undoTargetSideEffects: (...args: unknown[]) => Promise<void>;
  cutover: (...args: unknown[]) => Promise<{ failed: unknown[] }>;
  retireSourceRoutes: (...args: unknown[]) => Promise<void>;
};
let run: Run, events: string[], removed: string[];
let source: ReturnType<typeof fakeRuntime>, target: ReturnType<typeof fakeRuntime>;
let volumes: Map<string, { Labels: Record<string, string> }>;

function fakeRuntime() {
  return {
    assertReachable: vi.fn(async () => {}),
    inspectContainer: vi.fn(async (id: string) => ({ id, state: id === "asleep" ? "exited" : "running" })),
    listDeploymentContainers: vi.fn(async () => [{ containerId: "new-container" }]),
    listAllContainers: vi.fn(async () => []),
    start: vi.fn(async (id: string) => { events.push("start:" + id); }),
    stop: vi.fn(async (id: string) => { events.push("stop:" + id); }),
    destroy: vi.fn(async (id: string) => { events.push("destroy:" + id); }),
    dispose: vi.fn(async () => {}),
    docker: {
      listContainers: vi.fn(async () => []),
      getVolume: vi.fn((name: string) => ({
        inspect: vi.fn(async () => {
          if (!volumes.has(name)) throw Object.assign(new Error("missing"), { statusCode: 404 });
          return volumes.get(name)!;
        }),
        remove: vi.fn(async (options: { force: boolean }) => {
          expect(options).toEqual({ force: false });
          removed.push(name); volumes.delete(name);
        }),
      })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  events = []; removed = []; volumes = new Map();
  source = fakeRuntime(); target = fakeRuntime();
  run = {
    id: "run", organizationId: "org", sourceServerId: "source", targetServerId: "target",
    projectId: "project", projectName: "imported", mode: "cross_server", status: "rolled_back",
    confirmationToken: "token", scannedContainerIds: { web: "old-container" },
    targetVolumes: [], pendingItems: [], recovery: {}, inputSnapshot: {},
    lastEventAt: new Date(Date.now() - 60_000), executionStartedAt: new Date(0),
    executionFinishedAt: new Date(1), deploymentId: null,
  } as unknown as Run;
  vi.spyOn(repos.dockerMigrationRun, "findById").mockImplementation(async id => id === run.id ? run : undefined);
  vi.spyOn(repos.dockerMigrationRun, "listInFlight").mockImplementation(async () => [run]);
  vi.spyOn(repos.dockerMigrationRun, "updateTargetVolumes").mockImplementation(async (_id, names) => {
    events.push("record-volumes"); run = { ...run, targetVolumes: names };
  });
  vi.spyOn(repos.dockerMigrationRun, "updateRecovery").mockImplementation(async (_id, patch) => {
    events.push("checkpoint"); run = { ...run, recovery: { ...run.recovery, ...patch } };
  });
  vi.spyOn(repos.dockerMigrationRun, "transition").mockImplementation(async (_id, status, patch) => {
    events.push("status:" + status); run = { ...run, status, ...patch } as Run;
  });
  vi.spyOn(repos.dockerMigrationRun, "acknowledgeExecutionFinished").mockImplementation(async () => {
    events.push("ack"); run = { ...run, executionFinishedAt: new Date() };
  });
  vi.spyOn(repos.dockerMigrationRun, "claimExecution").mockImplementation(async input => {
    run = { ...run, status: input.to, executionFinishedAt: null }; return run;
  });
  vi.spyOn(repos.dockerMigrationRun, "updateLogs").mockResolvedValue();
  vi.spyOn(repos.dockerMigrationRun, "restoreProject").mockResolvedValue();
  vi.spyOn(repos.server, "getInOrganization").mockImplementation(async id => ({ id }) as never);
  vi.spyOn(repos.deployment, "findById").mockResolvedValue(undefined);
  vi.spyOn(repos.deployment, "hasLiveBuildExecution").mockResolvedValue(false);
  h.runtime.mockImplementation(async (id, org) => { expect(org).toBe("org"); return id === "source" ? source : target; });
  h.activity.mockImplementation(async (_org, _a, _b, _run, work) => work());
  h.tryLock.mockImplementation(async (_key, work) => work());
  h.prepare.mockImplementation(async () => { events.push("create-volumes"); });
  h.plan.mockResolvedValue({ items: [], createdVolumes: ["copy"], managedPaths: [] });
  h.transfer.mockResolvedValue(undefined);
  h.cancelBuild.mockResolvedValue({ pending: false });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const move = () => engine.moveData("project", "source", "target", "org",
  { web: "old-container", worker: "asleep" }, false, {}, [], [], { mode: "stream" }, {}, () => {}, undefined, "run");

describe("migration rollback and cleanup", () => {
  it("records prospective writes and running containers before stopping production", async () => {
    h.plan.mockResolvedValue({ items: [{ key: "data" }], createdVolumes: ["copy"], managedPaths: [] });
    h.transfer.mockImplementation(async () => { events.push("copy-data"); });
    await move();
    expect(events.indexOf("record-volumes")).toBeLessThan(events.indexOf("create-volumes"));
    expect(events.indexOf("checkpoint")).toBeLessThan(events.indexOf("stop:old-container"));
    expect(events.indexOf("stop:old-container")).toBeLessThan(events.indexOf("copy-data"));
    expect(source.stop).toHaveBeenCalledExactlyOnceWith("old-container");
    expect(run.recovery.sourceRunningContainerIds).toEqual({ web: "old-container" });
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(target.dispose).toHaveBeenCalledOnce();
  });
  it("fails before stopping a source when volume reservation fails", async () => {
    h.prepare.mockRejectedValueOnce(new Error("reservation conflict"));
    await expect(move()).rejects.toThrow("reservation conflict");
    expect(run.targetVolumes).toEqual(["copy"]);
    expect(source.stop).not.toHaveBeenCalled();
  });
  it("waits for all transfer writers before returning a cancellation", async () => {
    h.plan.mockResolvedValue({ items: [{ key: "one" }, { key: "two" }], createdVolumes: [], managedPaths: [] });
    let finish!: () => void;
    h.transfer.mockImplementationOnce(async () => { run.recovery.cancelRequested = true; throw new Error("cancel"); })
      .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const result = expect(move()).rejects.toThrow("Cancelled by user");
    await vi.waitFor(() => expect(h.transfer).toHaveBeenCalledTimes(2));
    expect(target.dispose).not.toHaveBeenCalled();
    finish(); await result;
    expect(target.dispose).toHaveBeenCalledOnce();
  });
  it("removes only exact run-owned volumes on the target", async () => {
    run.targetVolumes = ["owned", "sibling", "older", "gone"];
    volumes.set("owned", { Labels: { "openship.project": "project", "openship.migration": "run" } });
    volumes.set("sibling", { Labels: { "openship.project": "another", "openship.migration": "run" } });
    volumes.set("older", { Labels: { "openship.project": "project", "openship.migration": "old-run" } });
    expect(await migrationOrchestrator.cleanupTargetData("run", "org")).toEqual({ ok: true, removed: 1 });
    expect(removed).toEqual(["owned"]);
    expect([...volumes.keys()]).toEqual(["sibling", "older"]);
    expect(h.runtime).toHaveBeenCalledExactlyOnceWith("target", "org");
    expect(run.targetVolumes).toEqual([]);
  });
  it("uses the recorded draft identity after its project row has been deleted", async () => {
    run.projectId = null; run.recovery.createdProjectId = "project"; run.targetVolumes = ["copy"];
    volumes.set("copy", { Labels: { "openship.project": "project", "openship.migration": "run" } });
    expect(await migrationOrchestrator.cleanupTargetData("run", "org")).toEqual({ ok: true, removed: 1 });
  });
  it.each(["succeeded", "partial", "awaiting_cutover", "moving_data"])("refuses manual cleanup of %s", async status => {
    run.status = status;
    expect(await migrationOrchestrator.cleanupTargetData("run", "org")).toMatchObject({ ok: false, status: 409 });
    expect(h.runtime).not.toHaveBeenCalled();
  });
  it("refuses cleanup while a terminal-looking worker still owns its lease", async () => {
    run.executionFinishedAt = null;
    expect(await migrationOrchestrator.cleanupTargetData("run", "org")).toMatchObject({ ok: false, status: 409 });
    expect(h.runtime).not.toHaveBeenCalled();
  });
  it("restores only the source containers recorded as running", async () => {
    run.recovery.sourceRunningContainerIds = { web: "old-container" };
    await engine.restartSourceOriginals("source", "org", { web: "old-container", worker: "asleep" }, "run");
    expect(source.start).toHaveBeenCalledExactlyOnceWith("old-container");
    expect(target.start).not.toHaveBeenCalled();
  });
  it.each(["cross_server", "project_copy", "project_move"])("restores the placement only when %s is a move", async mode => {
    run.mode = mode;
    await engine.undoTargetSideEffects(run, { sourceServerId: "source", targetServerId: "target" }, "org", vi.fn());
    expect(repos.dockerMigrationRun.restoreProject).toHaveBeenCalledTimes(mode === "project_move" ? 1 : 0);
  });
  it("does not claim rollback succeeded while the source is unreachable", async () => {
    run.status = "verifying"; run.recovery.sourceRunningContainerIds = { web: "old-container" };
    source.start.mockRejectedValueOnce(new Error("SSH disconnected"));
    await expect(engine.rollback({ organizationId: "org" }, "run", { sourceServerId: "source", targetServerId: "target" },
      run.scannedContainerIds, undefined, undefined, "build failed")).rejects.toThrow("Could not restart");
    expect(run.status).toBe("verifying");
    expect(repos.dockerMigrationRun.restoreProject).not.toHaveBeenCalled();
  });
  it("waits for an active target build to confirm cancellation before restoring the source", async () => {
    run.status = "deploying"; run.deploymentId = "deployment";
    vi.mocked(repos.deployment.findById).mockResolvedValue({ id: "deployment", projectId: "project", status: "building" } as never);
    h.cancelBuild.mockResolvedValue({ pending: true });
    await expect(engine.rollback({ organizationId: "org" }, "run", { sourceServerId: "source", targetServerId: "target" },
      run.scannedContainerIds, "deployment", undefined, "cancelled")).rejects.toThrow("Waiting for the target deployment");
    expect(h.runtime).not.toHaveBeenCalled();
    expect(run.status).toBe("deploying");
  });
});

describe("replica and restart recovery", () => {
  it("skips another replica's active execution instead of queuing behind it", async () => {
    h.tryLock.mockResolvedValue(undefined);
    await migrationOrchestrator.recoverInterruptedMigrations();
    expect(repos.dockerMigrationRun.findById).not.toHaveBeenCalled();
    expect(h.runtime).not.toHaveBeenCalled();
  });
  it("gives a newly claimed worker time to start", async () => {
    run.lastEventAt = new Date();
    await migrationOrchestrator.recoverInterruptedMigrations();
    expect(h.tryLock).not.toHaveBeenCalled();
  });
  it("re-reads state after acquiring its lock instead of undoing a completed run", async () => {
    run.status = "moving_data";
    h.tryLock.mockImplementation(async (_key, work) => { run = { ...run, status: "succeeded" }; return work(); });
    await migrationOrchestrator.recoverInterruptedMigrations();
    expect(h.runtime).not.toHaveBeenCalled();
    expect(run.status).toBe("succeeded");
  });
  it("removes a failed target before restarting the source and restoring project placement", async () => {
    run.status = "verifying"; run.mode = "project_move"; run.deploymentId = "deployment";
    run.recovery.sourceRunningContainerIds = { web: "old-container" };
    await migrationOrchestrator.recoverInterruptedMigrations();
    expect(events.indexOf("destroy:new-container")).toBeLessThan(events.indexOf("start:old-container"));
    expect(repos.dockerMigrationRun.restoreProject).toHaveBeenCalledWith("run", "org");
    expect(run.status).toBe("rolled_back");
  });
  it("parks an interrupted resume without destroying its existing deployment", async () => {
    run.status = "moving_data"; run.recovery.worker = "resume";
    run.recovery.targetRunningContainerIds = ["new-container"]; run.executionFinishedAt = null;
    await migrationOrchestrator.recoverInterruptedMigrations();
    expect(target.start).toHaveBeenCalledExactlyOnceWith("new-container");
    expect(target.destroy).not.toHaveBeenCalled();
    expect(run.status).toBe("partial");
    expect(run.recovery.targetRunningContainerIds).toEqual([]);
    expect(run.executionFinishedAt).toBeInstanceOf(Date);
  });
  it("retains failed target restarts for the next recovery attempt", async () => {
    target.start.mockImplementation(async id => { if (id === "unreachable") throw new Error("host down"); });
    await expect(engine.restoreTargetContainers("run", target, ["healthy", "unreachable"])).rejects.toThrow("could not restart");
    expect(run.recovery.targetRunningContainerIds).toEqual(["unreachable"]);
  });
  it("keeps a failed cutover retryable and never rolls it back", async () => {
    run.status = "cutover"; run.mode = "project_move"; run.executionFinishedAt = null;
    const cutover = vi.spyOn(engine, "cutover").mockResolvedValue({ failed: [{ name: "web", containerId: "old-container", reason: "host down" }] });
    const retire = vi.spyOn(engine, "retireSourceRoutes").mockResolvedValue();
    await migrationOrchestrator.recoverInterruptedMigrations();
    expect(cutover).toHaveBeenCalledWith("source", "org", { web: "old-container" });
    expect(retire).not.toHaveBeenCalled();
    expect(source.start).not.toHaveBeenCalled();
    expect(target.destroy).not.toHaveBeenCalled();
    expect(run.status).toBe("cutover");
    expect(run.errorMessage).toContain("host down");
  });
  it("retries source routing after complete cutover using the original run identity", async () => {
    run.status = "cutover"; run.mode = "project_move";
    vi.spyOn(engine, "cutover").mockResolvedValue({ failed: [] });
    const retire = vi.spyOn(engine, "retireSourceRoutes").mockResolvedValue();
    await migrationOrchestrator.recoverInterruptedMigrations();
    expect(retire).toHaveBeenCalledExactlyOnceWith("project", "source", "org", true, "run");
    expect(run.status).toBe("succeeded");
  });
  it("requires the original destructive choice after a failed cutover claim", async () => {
    run.status = "awaiting_cutover";
    vi.spyOn(engine, "cutover").mockRejectedValueOnce(new Error("host lost")).mockResolvedValueOnce({ failed: [] });
    await expect(migrationOrchestrator.resolveCutover("run", "org", "token", true)).rejects.toThrow("host lost");
    expect(run.status).toBe("cutover");
    expect(run.executionFinishedAt).toBeInstanceOf(Date);
    expect(await migrationOrchestrator.resolveCutover("run", "org", "token", false)).toMatchObject({ ok: false, status: 409 });
    expect(await migrationOrchestrator.resolveCutover("run", "org", "wrong", true)).toMatchObject({ ok: false, status: 403 });
    expect(await migrationOrchestrator.resolveCutover("run", "org", "token", true)).toEqual({ ok: true, leftBehind: [] });
    expect(run.status).toBe("succeeded");
  });
});
