import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { DockerRuntime, OPENSHIP_LABEL, type DeployConfig } from "@repo/adapters";
import { repos, db, schema } from "@repo/db";
import { seedDeployment, seedOrg, seedProject, setActive } from "../../helpers/seed";
import {
  withProjectRuntimeTransition,
  withProjectStateLock,
  withLiveProjectRuntimeMutation,
} from "@repo/platform/engine/lib/project-runtime-lock";

const h = vi.hoisted(() => ({
  runtime: null as unknown,
  routing: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>()),
  withDeploymentRuntime: async (_dep: unknown, run: (runtime: unknown) => Promise<unknown>) =>
    run(h.runtime),
}));
vi.mock("@repo/platform/engine/modules/projects/project-runtime.service", () => ({
  retryProjectRouting: h.routing,
}));
vi.mock("@repo/platform/engine/modules/deployments/rollback/rollback-orchestrator", () => ({
  onDeploymentReady: vi.fn(async () => {}),
}));

const {
  assertRoleInventorySettled,
  beginRoleHandover,
  recoverProjectRoleHandovers,
  runRoleHandoverRecovery,
} = await import("@repo/platform/engine/modules/deployments/role-handover");

describe("durable role handover recovery (#1254)", () => {
  const containers = new Map<
    string,
    { id: string; labels: Record<string, string>; running: boolean }
  >();
  const removed: string[] = [];
  const restarted: string[] = [];
  let failRemoval = false;
  const projects: string[] = [];

  afterEach(async () => {
    for (const id of projects.splice(0))
      await db.delete(schema.project).where(eq(schema.project.id, id));
  });

  beforeEach(() => {
    containers.clear();
    removed.length = 0;
    restarted.length = 0;
    failRemoval = false;
    h.routing.mockClear();
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
    Object.assign(runtime, {
      capabilities: new Set(["roles"]),
      listAllContainers: async () =>
        [...containers.values()].map((row) => ({
          id: row.id,
          labels: row.labels,
          state: row.running ? "running" : "exited",
        })),
      _docker: {
        getContainer: (reference: string) => ({
          inspect: async () => {
            const row =
              containers.get(reference) ??
              [...containers.values()].find((row) => row.id === reference);
            if (!row) throw Object.assign(new Error("not found"), { statusCode: 404 });
            return { Id: row.id, Config: { Labels: row.labels } };
          },
        }),
      },
      destroy: async (id: string) => {
        if (failRemoval) throw new Error("Docker removal is uncertain");
        for (const [name, row] of containers) if (row.id === id) containers.delete(name);
        removed.push(id);
      },
      stop: async (id: string) => {
        const row = [...containers.values()].find((row) => row.id === id);
        if (row) row.running = false;
      },
      start: async (id: string) => {
        const row = [...containers.values()].find((row) => row.id === id);
        if (row) row.running = true;
        restarted.push(id);
      },
    });
    h.runtime = runtime;
  });

  async function fixture() {
    const org = await seedOrg();
    const project = await seedProject(org.organizationId);
    projects.push(project.id);
    const previous = await seedDeployment(project, {
      containerId: "old-web",
      meta: { runtimeMode: "docker" },
    });
    await repos.deployment.setRoleContainers(previous.id, [
      { role: "scheduler", replica: 1, containerId: "old-scheduler" },
    ]);
    previous.roleContainers = [{ role: "scheduler", replica: 1, containerId: "old-scheduler" }];
    await setActive(project.id, previous.id);
    const dep = await seedDeployment(project, {
      status: "deploying",
      meta: { runtimeMode: "docker" },
    });
    const config = {
      projectId: project.id,
      deploymentId: dep.id,
      runtimeName: "app",
    } as DeployConfig;
    const journal = await beginRoleHandover({
      dep,
      previous,
      config,
      roles: [{ name: "scheduler", kind: "scheduler", command: "exec cron" }],
    });
    const put = (name: string, id: string, deploymentId: string, role?: string) => {
      containers.set(name, {
        id,
        running: true,
        labels: {
          [OPENSHIP_LABEL.project]: project.id,
          [OPENSHIP_LABEL.deployment]: deploymentId,
          ...(role ? { [OPENSHIP_LABEL.role]: role } : {}),
        },
      });
    };
    put("old-web", "old-web", previous.id);
    put("old-scheduler", "old-scheduler", previous.id, "scheduler");
    const candidateName = DockerRuntime.deploymentContainerName(config, {
      name: "scheduler",
      replica: 1,
    });
    return { project, previous, dep, config, journal, put, candidateName };
  }

  it("protects a published handover from a late failure or cancellation, even while recovery is pending", async () => {
    const { onFailure, onCancelled, reportPipelineError } =
      await import("@repo/platform/engine/modules/deployments/deployment-lifecycle");
    const f = await fixture();
    await f.journal.committing();
    const log = vi.fn();
    const ctx = {
      project: f.project,
      dep: f.dep,
      buildSessionId: "no-live-session",
      persistLogs: () => [],
      provisioned: {},
    };
    await onFailure(ctx, "late failure");
    await reportPipelineError(ctx, "late transport failure", { log });
    expect((await repos.deployment.findById(f.dep.id))?.status).toBe("reconciling");
    expect(removed).toEqual([]);
    await repos.deployment.updateStatus(f.dep.id, "ready");
    await setActive(f.project.id, f.dep.id);
    const recovered = { ...ctx, settled: undefined };
    await onCancelled(recovered);
    expect(recovered.settled).toBe("ready");
    await reportPipelineError(recovered, "late cancellation", { log });
    expect((await repos.deployment.findById(f.dep.id))?.status).toBe("ready");
  });

  it.each([false, true])(
    "protects carried web and replicas while recovering a configuration revision (committing=%s)",
    async (committing) => {
      const f = await fixture();
      const carried = [{ ...f.previous.roleContainers![0], ownerDeploymentId: f.previous.id }];
      const journal = await beginRoleHandover({
        dep: f.dep,
        previous: f.previous,
        config: f.config,
        roles: [{ name: "scheduler", kind: "scheduler", command: "exec cron" }],
        reuse: carried,
        preserveWeb: { containerId: "old-web", ownerDeploymentId: f.previous.id },
      });
      expect(f.dep.roleHandover?.version).toBe(2);
      if (committing) {
        await journal.recordWeb("old-web");
        await journal.committing();
      }
      await recoverProjectRoleHandovers(f.project.id);
      expect(removed).toEqual([]);
      expect(containers.get("old-scheduler")?.running).toBe(true);
      expect(containers.get("old-web")?.running).toBe(true);
      expect((await repos.deployment.findById(f.dep.id))?.roleContainers).toEqual(carried);
      expect(h.routing).not.toHaveBeenCalled();
      expect((await repos.project.findById(f.project.id))?.activeDeploymentId).toBe(
        committing ? f.dep.id : f.previous.id,
      );
    },
  );

  it("recovers a lost create response by its durable name before restoring the predecessor", async () => {
    const f = await fixture();
    await f.journal.recordStopIntent(f.previous.roleContainers![0]);
    containers.get("old-scheduler")!.running = false;
    // Controller dies before recordCreated: the row has no candidate ID.
    f.put(f.candidateName, "replacement", f.dep.id, "scheduler");
    expect((await repos.deployment.findById(f.dep.id))?.roleContainers).toEqual([]);
    await recoverProjectRoleHandovers(f.project.id);
    expect(removed).toEqual(["replacement"]);
    expect(restarted).toEqual(["old-scheduler"]);
    expect(
      [...containers.values()].filter((row) => row.running && row.labels[OPENSHIP_LABEL.role]),
    ).toHaveLength(1);
    expect(await repos.deployment.listPendingRoleHandovers(f.project.id)).toEqual([]);
    await recoverProjectRoleHandovers(f.project.id);
    expect(restarted).toEqual(["old-scheduler"]);
  });

  it("keeps recovery fenced after an uncertain removal and succeeds on retry", async () => {
    const f = await fixture();
    await f.journal.recordStopIntent(f.previous.roleContainers![0]);
    containers.get("old-scheduler")!.running = false;
    f.put(f.candidateName, "replacement", f.dep.id, "scheduler");
    failRemoval = true;
    await expect(recoverProjectRoleHandovers(f.project.id)).rejects.toThrow("uncertain");
    expect(restarted).toEqual([]);
    expect(await repos.deployment.listPendingRoleHandovers(f.project.id)).toHaveLength(1);
    failRemoval = false;
    await recoverProjectRoleHandovers(f.project.id);
    expect(restarted).toEqual(["old-scheduler"]);
  });

  it("finishes a published commit after a crash before the active pointer update", async () => {
    const f = await fixture();
    f.put(f.candidateName, "replacement", f.dep.id, "scheduler");
    f.put(DockerRuntime.deploymentContainerName(f.config), "new-web", f.dep.id);
    await f.journal.recordCreated({ role: "scheduler", replica: 1, containerId: "replacement" });
    await f.journal.recordWeb("new-web");
    await f.journal.committing();
    await repos.deployment.sweepStaleInFlight("process restarted");
    expect((await repos.deployment.findById(f.dep.id))?.status).toBe("deploying");
    await recoverProjectRoleHandovers(f.project.id);
    expect((await repos.project.findById(f.project.id))?.activeDeploymentId).toBe(f.dep.id);
    expect((await repos.deployment.findById(f.dep.id))?.status).toBe("ready");
    expect(removed).toEqual(["old-scheduler", "old-web"]);
    expect(restarted).toEqual([]);
    expect(containers.get(f.candidateName)?.running).toBe(true);
    expect(await repos.deployment.listPendingRoleHandovers(f.project.id)).toEqual([]);
  });

  it("rejects late cancellation after the publish boundary", async () => {
    const f = await fixture();
    await f.journal.committing();
    expect(await repos.deployment.cancelInFlight(f.dep.id)).toBe(false);
    expect((await repos.deployment.findById(f.dep.id))?.status).toBe("deploying");
  });

  it("does not remove a foreign container that occupies a planned name", async () => {
    const f = await fixture();
    f.put(f.candidateName, "foreign", f.previous.id, "scheduler");
    await expect(recoverProjectRoleHandovers(f.project.id)).rejects.toThrow("different workload");
    expect(removed).toEqual([]);
    expect(restarted).toEqual([]);
  });

  it("never restarts a superseded scheduler", async () => {
    const f = await fixture();
    await f.journal.recordStopIntent(f.previous.roleContainers![0]);
    f.put(f.candidateName, "replacement", f.dep.id, "scheduler");
    const newer = await seedDeployment(f.project);
    await setActive(f.project.id, newer.id);
    await recoverProjectRoleHandovers(f.project.id);
    expect(restarted).toEqual([]);
    expect(removed).toEqual(["replacement"]);
    expect((await repos.project.findById(f.project.id))?.activeDeploymentId).toBe(newer.id);
  });

  it("leaves explicitly kept containers unchanged", async () => {
    const f = await fixture();
    f.put(f.candidateName, "kept", f.dep.id, "scheduler");
    await f.journal.kept();
    await expect(recoverProjectRoleHandovers(f.project.id)).rejects.toMatchObject({
      code: "ROLE_HANDOVER_RECOVERY_PENDING",
    });
    expect(removed).toEqual([]);
    expect(restarted).toEqual([]);
  });

  it("does not recover a live execution lease", async () => {
    const f = await fixture();
    await db.insert(schema.buildSession).values({
      id: `session-${f.dep.id}`,
      deploymentId: f.dep.id,
      projectId: f.project.id,
      status: "deploying",
      startedAt: new Date(),
    });
    const result = await runRoleHandoverRecovery();
    expect(result.recovered).toBe(0);
    expect(removed).toEqual([]);
    expect(restarted).toEqual([]);
  });

  it("blocks a new queued deployment until terminal-looking role cleanup has completed", async () => {
    const f = await fixture();
    await repos.deployment.updateStatus(f.dep.id, "cancelled");
    const input = {
      projectId: f.project.id,
      organizationId: f.project.organizationId,
      branch: "main",
      status: "queued",
    };
    await expect(repos.deployment.create(input)).rejects.toMatchObject({
      code: "ROLE_HANDOVER_RECOVERY_PENDING",
    });
    await recoverProjectRoleHandovers(f.project.id);
    expect(await repos.deployment.create(input)).toMatchObject({
      projectId: f.project.id,
      status: "queued",
    });
  });

  it("does not cross the publish boundary when cancellation won first", async () => {
    const f = await fixture();
    expect(await repos.deployment.cancelInFlight(f.dep.id)).toBe(true);
    await expect(f.journal.committing()).rejects.toMatchObject({
      code: "ROLE_HANDOVER_STATE_CHANGED",
    });
    expect((await repos.deployment.findById(f.dep.id))?.roleHandover?.phase).toBe("preparing");
    expect(removed).toEqual([]);
  });

  it("rejects a stale controller write after recovery completes", async () => {
    const f = await fixture();
    await recoverProjectRoleHandovers(f.project.id);
    await expect(
      f.journal.recordCreated({ role: "scheduler", replica: 1, containerId: "late" }),
    ).rejects.toMatchObject({ code: "ROLE_HANDOVER_STATE_CHANGED" });
    expect((await repos.deployment.findById(f.dep.id))?.roleHandover?.phase).toBe("complete");
    expect((await repos.deployment.findById(f.dep.id))?.roleContainers).toEqual([]);
  });

  it("fences ordinary project edits and runtime writers while allowing its transition owner", async () => {
    const f = await fixture();
    const edit = () => repos.project.update(f.project.id, { name: "changed" });
    await expect(withProjectStateLock(f.project.id, edit)).rejects.toMatchObject({
      code: "ROLE_HANDOVER_RECOVERY_PENDING",
    });
    await expect(withLiveProjectRuntimeMutation(f.project.id, edit)).rejects.toMatchObject({
      code: "ROLE_HANDOVER_RECOVERY_PENDING",
    });
    expect((await repos.project.findById(f.project.id))?.name).toBe(f.project.name);
    await withProjectRuntimeTransition(f.project.id, () =>
      withProjectStateLock(f.project.id, edit),
    );
    expect((await repos.project.findById(f.project.id))?.name).toBe("changed");
    await expect(withProjectStateLock(f.project.id, edit)).rejects.toMatchObject({
      code: "ROLE_HANDOVER_RECOVERY_PENDING",
    });
  });

  it("refuses a legacy untracked process without deleting it by labels", async () => {
    const f = await fixture();
    f.put(f.candidateName, "legacy-orphan", f.dep.id, "scheduler");
    await expect(
      assertRoleInventorySettled(
        h.runtime as DockerRuntime,
        f.project.id,
        f.previous.roleContainers!,
      ),
    ).rejects.toMatchObject({ code: "ROLE_HANDOVER_RECOVERY_PENDING" });
    expect(removed).toEqual([]);
    expect(restarted).toEqual([]);
    containers.get(f.candidateName)!.running = false;
    await expect(
      assertRoleInventorySettled(
        h.runtime as DockerRuntime,
        f.project.id,
        f.previous.roleContainers!,
      ),
    ).resolves.toBeUndefined();
  });
});
