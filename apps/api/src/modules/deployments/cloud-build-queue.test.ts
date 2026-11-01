import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, withKeyedMutex } from "@repo/core";
import type { ResourceConfig } from "@repo/adapters";
import type { BackupPolicy, Deployment, Project } from "@repo/db";
import type { PreDeployBackupPolicy } from "@repo/platform/engine/modules/backups/triggers/pre-deploy";

// Real admission, FIFO loop, resource decision, and keyed serialization. Only
// durable storage, plan lookup, provider I/O, and the launched worker are faked.
const h = vi.hoisted(() => ({
  cloud: true,
  limit: 1 as number | null,
  legacy: 0,
  rows: new Map<string, Deployment>(),
  requested: [] as string[],
  reservations: [] as {
    resources: ResourceConfig | null;
    projectId?: string;
    deploymentId?: string;
    finishedAt?: Date | null;
    slotReleasedAt?: Date | null;
    exclusivePreparation?: boolean;
  }[],
  session: vi.fn(),
  request: vi.fn(),
  list: vi.fn(),
  count: vi.fn(),
  wait: vi.fn(),
  fail: vi.fn(),
  plan: vi.fn(),
  sample: vi.fn(),
  ensure: vi.fn(),
  exclusive: vi.fn(),
  mode: vi.fn(),
  kickoff: vi.fn(),
  reservationRead: vi.fn(),
  activeRead: vi.fn(),
  policies: vi.fn(),
  diagnostic: vi.fn(),
}));
vi.mock("@repo/core/diagnostics", () => ({ diagnostics: { error: h.diagnostic } }));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
  },
}));
vi.mock("@repo/db", () => ({
  repos: {
    deployment: {
      findBuildSessionByDeploymentId: h.session,
      findById: async (id: string) => h.rows.get(id),
      requestCloudBuild: h.request,
      listRequestedCloudBuilds: h.list,
      countActiveCloudBuilds: h.count,
      setCloudBuildQueueWait: h.wait,
      failUnclaimedCloudBuild: h.fail,
    },
    cloudBuildActivity: { listReservations: h.reservationRead, listActive: h.activeRead },
    backupPolicy: { listEnabledPreDeployByProject: h.policies },
    project: {
      findByIdInOrganization: async (id: string, org: string) => ({
        id,
        organizationId: org,
        workspaceId: "w",
      }),
    },
  },
}));
vi.mock("@repo/platform/engine/lib/plan-guard", async () => {
  const { AppError } = await import("@repo/core");
  return {
    planBuildConcurrency: h.plan,
    currentPlanTier: async () => "hobby",
    PlanUpgradeRequiredError: class extends AppError {
      constructor(message: string) {
        super(message, 402, "PLAN_UPGRADE_REQUIRED");
      }
    },
  };
});
vi.mock("@repo/platform/engine/lib/provision-lock", () => ({
  createProvisionLock: (key: string) => ({
    run: (work: () => Promise<unknown>) => withKeyedMutex(key, work),
  }),
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-host", () => ({
  sampleCloudWorkspaceResources: h.sample,
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-lock", () => ({
  withCloudWorkspaceActivity: h.exclusive,
}));
vi.mock("@repo/platform/engine/lib/cloud-docker-workspace", () => ({
  ensureCloudDockerWorkspace: h.ensure,
}));
vi.mock("@repo/platform/engine/modules/deployments/build-pipeline", () => ({
  resolveServicePipelineMode: h.mode,
  kickoffBuild: h.kickoff,
}));
import {
  admitCloudBuild,
  drainCloudBuildQueue,
} from "@repo/platform/engine/modules/deployments/cloud-build-queue";

const project = { id: "p", organizationId: "org", workspaceId: "w" } as Project;
const budget = { cpuCores: 1, memoryMb: 1024, diskMb: 0 };
const sample = () => ({
  capacity: { cpuCores: 8, memoryMb: 16384 },
  usage: { available: true, cpuPercent: 10, memoryAvailableMb: 16384 },
});
function dep(
  id: string,
  meta: Record<string, unknown> | null = { buildResources: budget },
): Deployment {
  const row = { id, projectId: "p", organizationId: "org", status: "queued", meta } as Deployment;
  h.rows.set(id, row);
  return row;
}
function start(id: string) {
  return vi.fn(
    async (
      resources?: ResourceConfig | null,
      backupPolicies?: readonly PreDeployBackupPolicy[],
    ) => {
      h.rows.get(id)!.status = "building";
      h.reservations.push({
        resources: resources ?? null,
        projectId: h.rows.get(id)!.projectId,
        deploymentId: id,
        finishedAt: null,
        slotReleasedAt: null,
        exclusivePreparation: !!backupPolicies?.length,
      });
      return `session-${id}`;
    },
  );
}
function queued(id: string, meta?: Record<string, unknown> | null) {
  const row = dep(id, meta);
  h.requested.push(id);
  return row;
}
beforeEach(() => {
  vi.resetAllMocks();
  h.cloud = true;
  h.limit = 1;
  h.legacy = 0;
  h.rows.clear();
  h.requested = [];
  h.reservations = [];
  h.plan.mockImplementation(async () => h.limit);
  h.session.mockImplementation(async (id: string) => ({ id: `session-${id}` }));
  h.request.mockImplementation(async (id: string) => {
    if (!h.requested.includes(id)) h.requested.push(id);
  });
  h.count.mockImplementation(async () => h.legacy);
  h.reservationRead.mockImplementation(async () => h.reservations);
  h.activeRead.mockImplementation(async () =>
    h.reservations.map((row) => ({ exclusivePreparation: false, ...row })),
  );
  h.policies.mockResolvedValue([]);
  h.list.mockImplementation(async (_workspace?: string, limit = 200, offset = 0) =>
    h.requested
      .map((id) => h.rows.get(id)!)
      .filter((row) => row.status === "queued")
      .slice(offset, offset + limit),
  );
  h.sample.mockResolvedValue(sample());
  h.exclusive.mockImplementation(async (_workspace, work) => work());
  h.mode.mockResolvedValue({ useServicePipeline: false, servicePreflightServices: [] });
  h.fail.mockImplementation(async ({ deploymentId }) => {
    h.rows.get(deploymentId)!.status = "failed";
    return true;
  });
  h.kickoff.mockImplementation(async (project, dep) =>
    admitCloudBuild(project, dep, start(dep.id)),
  );
});

describe("Cloud build admission", () => {
  it.each([false, true])(
    "keeps an atomic maintenance refusal queued and retries later (image-only: %s)",
    async (imageOnly) => {
      const row = dep(
        "maintenance",
        imageOnly ? { releaseImageRef: "image:v1" } : { buildResources: budget },
      );
      const run = vi
        .fn()
        .mockRejectedValueOnce(
          new AppError("Maintenance started", 409, "CLOUD_WORKSPACE_ACTIVITY_BUSY"),
        )
        .mockImplementation(start(row.id));
      await expect(admitCloudBuild(project, row, run)).resolves.toBe("session-maintenance");
      expect(row.status).toBe("queued");
      expect(h.reservations).toEqual([]);
      expect(h.wait).toHaveBeenCalledWith(
        row.id,
        "org",
        expect.objectContaining({ reason: "server" }),
      );
      await admitCloudBuild(project, row, run);
      expect(row.status).toBe("building");
      expect(run).toHaveBeenCalledTimes(2);
    },
  );
  it("serializes simultaneous requests under the cap and admits the next after slot release", async () => {
    const rows = [dep("a"), dep("b"), dep("c")];
    const starts = rows.map((row) => start(row.id));
    await Promise.all(rows.map((row, index) => admitCloudBuild(project, row, starts[index]!)));
    expect(starts.map((run) => run.mock.calls.length)).toEqual([1, 0, 0]);
    expect(starts[0]).toHaveBeenCalledWith(budget, []);
    expect(h.wait).toHaveBeenCalledWith(
      "b",
      "org",
      expect.objectContaining({ reason: "concurrency", limit: 1 }),
    );
    h.reservations = [];
    await admitCloudBuild(project, rows[2]!, starts[2]!);
    expect(starts[2]).not.toHaveBeenCalled();
    await admitCloudBuild(project, rows[1]!, starts[1]!);
    expect(starts[1]).toHaveBeenCalledOnce();
  });
  it("admits uncapped siblings up to the plan ceiling without changing settings or sampling usage", async () => {
    h.limit = 4;
    const first = dep("automatic-a", {});
    const second = dep("automatic-b", {});
    h.sample.mockResolvedValue({ ...sample(), usage: { available: false } });
    const firstStart = start(first.id);
    const secondStart = start(second.id);
    await Promise.all([
      admitCloudBuild(project, first, firstStart),
      admitCloudBuild(project, second, secondStart),
    ]);
    expect(firstStart).toHaveBeenCalledWith({ cpuCores: 0, memoryMb: 0, diskMb: 0 }, []);
    expect(secondStart).toHaveBeenCalledWith({ cpuCores: 0, memoryMb: 0, diskMb: 0 }, []);
    expect(h.wait).not.toHaveBeenCalled();
    expect(h.sample.mock.calls.every(call => call[2] === false)).toBe(true);
    expect(first.meta).toEqual({});
    expect(second.meta).toEqual({});
  });
  it.each([1, 4])("keeps the plan ceiling of %s for fully uncapped builds", async limit => {
    h.limit = limit;
    const rows = Array.from({ length: limit + 1 }, (_, index) => dep(`uncapped-${index}`, {}));
    const starts = rows.map(row => start(row.id));
    for (let index = 0; index < rows.length; index++) await admitCloudBuild(project, rows[index]!, starts[index]!);
    expect(starts.filter(callback => callback.mock.calls.length > 0)).toHaveLength(limit);
    expect(h.wait).toHaveBeenCalledWith(rows.at(-1)!.id, "org", expect.objectContaining({ reason: "concurrency", limit }));
  });
  it.each([4, null])(
    "respects purchased/unlimited cap %s and ignores null-resource activity",
    async (limit) => {
      h.limit = limit;
      h.reservations = [{ resources: null }];
      const rows = Array.from({ length: 5 }, (_, i) => dep(String(i)));
      const starts = rows.map((row) => start(row.id));
      await Promise.all(rows.map((row, index) => admitCloudBuild(project, row, starts[index]!)));
      expect(starts.filter((run) => run.mock.calls.length)).toHaveLength(limit ?? 5);
      expect(h.count).toHaveBeenCalledWith("w", "org");
      expect(h.reservationRead).toHaveBeenCalledWith("w", "org");
      expect(h.plan).toHaveBeenCalledWith("org", "w");
    },
  );
  it("waits for legacy exclusive execution even below the plan cap", async () => {
    h.legacy = 1;
    h.limit = 4;
    const run = start("a");
    await admitCloudBuild(project, dep("a"), run);
    expect(run).not.toHaveBeenCalled();
    expect(h.sample).not.toHaveBeenCalled();
    expect(h.wait).toHaveBeenCalledWith("a", "org", expect.objectContaining({ reason: "server" }));
  });
  it.each(["memory", "cpu", "unknown"])(
    "waits for %s pressure using the real resource helper",
    async (pressure) => {
      const usage = sample().usage;
      if (pressure === "memory") usage.memoryAvailableMb = 512;
      if (pressure === "cpu") usage.cpuPercent = 99;
      if (pressure === "unknown") usage.available = false;
      h.sample.mockResolvedValue({ ...sample(), usage });
      const run = start("a");
      await admitCloudBuild(project, dep("a"), run);
      expect(run).not.toHaveBeenCalled();
      expect(h.wait).toHaveBeenCalledWith(
        "a",
        "org",
        expect.objectContaining({ reason: "resources" }),
      );
    },
  );
  it("includes outstanding memory reservations when deciding resource waits", async () => {
    h.limit = 10;
    h.reservations = [{ resources: { ...budget, memoryMb: 15000 } }];
    const run = start("a");
    await admitCloudBuild(project, dep("a"), run);
    expect(run).not.toHaveBeenCalled();
    expect(h.wait).toHaveBeenCalledWith(
      "a",
      "org",
      expect.objectContaining({ reason: "resources" }),
    );
  });
  it.each([
    { cpuCores: 9, memoryMb: 1024 },
    { cpuCores: 1, memoryMb: 20000 },
  ])("rejects structurally impossible resources %j", async (requested) => {
    const run = start("a");
    await expect(
      admitCloudBuild(project, dep("a", { buildResources: requested }), run),
    ).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_BUILD_CAPACITY" });
    expect(run).not.toHaveBeenCalled();
    expect(h.wait).not.toHaveBeenCalled();
  });
  it("reports invalid resource settings as a configuration error rather than an upgrade requirement", async () => {
    const run = start("a");
    await expect(
      admitCloudBuild(project, dep("a", { buildResources: { cpuCores: -1, memoryMb: 1024 } }), run),
    ).rejects.toMatchObject({ statusCode: 400, code: "CLOUD_BUILD_RESOURCES_INVALID" });
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    new Error("transport reset"),
    new AppError("provider unavailable", 503, "PROVIDER_UNAVAILABLE"),
    new AppError("server busy", 409, "CLOUD_WORKSPACE_ACTIVITY_BUSY"),
  ])("retains a transient server failure: %s", async (error) => {
    h.sample.mockRejectedValue(error);
    const run = start("a");
    await admitCloudBuild(project, dep("a"), run);
    expect(run).not.toHaveBeenCalled();
    expect(h.wait).toHaveBeenCalledWith("a", "org", expect.objectContaining({ reason: "server" }));
    expect(h.rows.get("a")!.status).toBe("queued");
  });
  it.each(["CLOUD_WORKSPACE_NOT_READY", "CLOUD_WORKSPACE_NOT_RUNNING"])(
    "provisions through the lifecycle fence for %s, then resamples",
    async (code) => {
      h.sample.mockRejectedValueOnce(new AppError("not ready", 409, code));
      const run = start("a");
      await admitCloudBuild(project, dep("a"), run);
      expect(h.exclusive).toHaveBeenCalledWith("w", expect.any(Function), undefined, {
        scope: "project:p",
      });
      expect(h.ensure).toHaveBeenCalledWith({ projectId: "p", organizationId: "org" });
      expect(h.sample).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenCalledWith(budget, []);
    },
  );
  it("keeps waiting if lifecycle admission is busy", async () => {
    h.sample.mockRejectedValueOnce(new AppError("not ready", 409, "CLOUD_WORKSPACE_NOT_READY"));
    h.exclusive.mockRejectedValue(new AppError("busy", 409, "CLOUD_WORKSPACE_ACTIVITY_BUSY"));
    const run = start("a");
    await admitCloudBuild(project, dep("a"), run);
    expect(run).not.toHaveBeenCalled();
    expect(h.wait).toHaveBeenCalledWith("a", "org", expect.objectContaining({ reason: "server" }));
  });
  it("allows an image-only release through a full build queue without reserving resources", async () => {
    queued("earlier");
    h.reservations = [{ resources: budget }];
    const run = start("image");
    await admitCloudBuild(project, dep("image", { releaseImageRef: "image:v1" }), run);
    expect(run).toHaveBeenCalledWith(null, []);
  });
  it("treats a source-building service as requiring a build slot", async () => {
    h.mode.mockResolvedValue({
      useServicePipeline: true,
      servicePreflightServices: [{ name: "web", enabled: true, build: "." }],
    });
    h.reservations = [{ resources: budget }];
    const run = start("a");
    await admitCloudBuild(project, dep("a"), run);
    expect(run).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "does no Cloud reads for selfhost or a missing workspace (missing workspace: %s)",
    async (noWorkspace) => {
      h.cloud = noWorkspace;
      h.limit = 0;
      const run = start("a");
      await admitCloudBuild(
        { ...project, ...(noWorkspace ? { workspaceId: null } : {}) },
        dep("a"),
        run,
      );
      expect(run).toHaveBeenCalledWith();
      expect(h.request).not.toHaveBeenCalled();
      expect(h.plan).not.toHaveBeenCalled();
      expect(h.reservationRead).not.toHaveBeenCalled();
    },
  );
  it("rejects a zero plan allowance before starting host work", async () => {
    h.limit = 0;
    const run = start("a");
    await expect(admitCloudBuild(project, dep("a"), run)).rejects.toMatchObject({
      code: "PLAN_UPGRADE_REQUIRED",
      statusCode: 402,
    });
    expect(run).not.toHaveBeenCalled();
    expect(h.sample).not.toHaveBeenCalled();
  });
  it("refuses foreign ownership before any submission", async () => {
    await expect(
      admitCloudBuild(project, { ...dep("a"), organizationId: "other" }, start("a")),
    ).rejects.toMatchObject({ code: "BUILD_OWNERSHIP_MISMATCH" });
    expect(h.request).not.toHaveBeenCalled();
  });
  it("ignores absent sessions and already-claimed rows", async () => {
    h.session.mockResolvedValueOnce(null);
    const row = dep("a"),
      run = start("a");
    expect(await admitCloudBuild(project, row, run)).toBeNull();
    expect(h.request).not.toHaveBeenCalled();
    row.status = "building";
    await admitCloudBuild(project, row, run);
    expect(run).not.toHaveBeenCalled();
    expect(h.plan).not.toHaveBeenCalled();
  });
});

describe("Cloud queue pre-deploy backup exclusion", () => {
  // Spare plan slots and ample resources isolate the exclusive-backup gate.
  beforeEach(() => {
    h.limit = 4;
  });

  it.each([
    { backupProject: "p", released: false, label: "backup candidate waits for a sibling build" },
    {
      backupProject: "sibling",
      released: false,
      label: "ordinary candidate waits for a backup-owning sibling",
    },
    {
      backupProject: "p",
      released: true,
      label: "backup candidate waits after sibling's build slot is released",
    },
    {
      backupProject: "sibling",
      released: true,
      label: "ordinary candidate waits while backup-owning sibling is deploying",
    },
  ])("$label", async ({ backupProject, released }) => {
    h.policies.mockImplementation(async (projectId: string) =>
      projectId === backupProject ? [{ id: "pre-deploy-policy" }] : [],
    );
    const activity = {
      projectId: "sibling",
      deploymentId: "sibling-deployment",
      resources: budget,
      finishedAt: null,
      slotReleasedAt: released ? new Date() : null,
      exclusivePreparation: backupProject === "sibling",
    };
    h.reservations = released ? [] : [activity];
    h.activeRead.mockResolvedValue([activity]);
    const candidate = dep("candidate"),
      run = start(candidate.id);

    expect(await admitCloudBuild(project, candidate, run)).toBe("session-candidate");
    expect(run).not.toHaveBeenCalled();
    expect(h.wait).toHaveBeenCalledWith(
      candidate.id,
      "org",
      expect.objectContaining({ reason: "server" }),
    );
    expect(h.activeRead).toHaveBeenCalledWith("w", "org");
    expect(h.sample).not.toHaveBeenCalled();
    expect(h.fail).not.toHaveBeenCalled();
    expect(candidate.status).toBe("queued");

    // Finishing the activity, not merely freeing the build slot, unblocks it.
    h.reservations = [];
    h.activeRead.mockResolvedValue([]);
    await admitCloudBuild(project, candidate, run);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      budget,
      backupProject === "p" ? [{ id: "pre-deploy-policy" }] : [],
    );
  });

  it("also fences image-only deployments that need pre-deploy backups", async () => {
    h.policies.mockImplementation(async (projectId: string) =>
      projectId === "p" ? [{ id: "pre-deploy-policy" }] : [],
    );
    h.activeRead.mockResolvedValue([
      {
        projectId: "sibling",
        deploymentId: "sibling-image",
        resources: null,
        finishedAt: null,
        exclusivePreparation: false,
      },
    ]);
    const candidate = dep("image", { releaseImageRef: "image:v1" }),
      run = start(candidate.id);
    await admitCloudBuild(project, candidate, run);
    expect(run).not.toHaveBeenCalled();
    expect(h.wait).toHaveBeenCalledWith(
      candidate.id,
      "org",
      expect.objectContaining({ reason: "server" }),
    );
  });

  it("deleting a policy does not relax an existing exclusive-preparation reservation", async () => {
    h.policies.mockResolvedValue([{ id: "pre-deploy-policy" }]);
    const backup = dep("backup"),
      backupStart = start(backup.id);
    await admitCloudBuild(project, backup, backupStart);
    expect(backupStart).toHaveBeenCalledExactlyOnceWith(budget, [{ id: "pre-deploy-policy" }]);
    expect(h.reservations[0]?.exclusivePreparation).toBe(true);

    // The policy disappears after admission; its durable reservation still
    // protects the already-frozen backup preparation, including after building.
    const activity = { ...h.reservations[0]!, slotReleasedAt: new Date() };
    h.reservations = [];
    h.activeRead.mockResolvedValue([activity]);
    h.policies.mockClear().mockResolvedValue([]);
    const candidate = { ...dep("ordinary"), projectId: "ordinary-project" };
    h.rows.set(candidate.id, candidate);
    const run = start(candidate.id);
    await admitCloudBuild({ ...project, id: candidate.projectId }, candidate, run);
    expect(run).not.toHaveBeenCalled();
    expect(h.wait).toHaveBeenCalledWith(
      candidate.id,
      "org",
      expect.objectContaining({ reason: "server" }),
    );
    expect(h.policies).toHaveBeenCalledExactlyOnceWith(candidate.projectId);
  });

  it.each([false, true])(
    "forwards frozen empty policies even when policies are added before worker start (image-only: %s)",
    async (imageOnly) => {
      const frozen: BackupPolicy[] = [];
      h.policies.mockResolvedValue(frozen);
      h.sample.mockImplementationOnce(async () => {
        // Provider sampling yields after the candidate's single policy read.
        h.policies.mockResolvedValue([{ id: "added-after-admission" }]);
        return sample();
      });
      const candidate = dep(
        "candidate",
        imageOnly ? { releaseImageRef: "image:v1" } : { buildResources: budget },
      );
      const run = start(candidate.id);
      await admitCloudBuild(project, candidate, run);
      expect(h.policies).toHaveBeenCalledExactlyOnceWith(project.id);
      expect(run).toHaveBeenCalledExactlyOnceWith(imageOnly ? null : budget, []);
      expect(run.mock.calls[0]?.[1]).toBe(frozen);
      expect(h.reservations[0]?.exclusivePreparation).toBe(false);
    },
  );

  it.each(["backup", "ordinary"])(
    "serializes admission when the %s job arrives first",
    async (first) => {
      h.policies.mockImplementation(async (projectId: string) =>
        projectId === "backup-project" ? [{ id: "pre-deploy-policy" }] : [],
      );
      const backup = { ...dep("backup"), projectId: "backup-project" };
      const ordinary = { ...dep("ordinary"), projectId: "ordinary-project" };
      h.rows.set(backup.id, backup);
      h.rows.set(ordinary.id, ordinary);
      const ordered = first === "backup" ? [backup, ordinary] : [ordinary, backup];
      const starts = ordered.map((row) => start(row.id));
      await Promise.all(
        ordered.map((row, index) =>
          admitCloudBuild({ ...project, id: row.projectId }, row, starts[index]!),
        ),
      );
      expect(starts[0]).toHaveBeenCalledOnce();
      expect(starts[1]).not.toHaveBeenCalled();
      expect(h.wait).toHaveBeenCalledWith(
        ordered[1]!.id,
        "org",
        expect.objectContaining({ reason: "server" }),
      );
    },
  );
});

describe("Cloud queue drain", () => {
  it("removes a permanently poisoned head and starts the next submitted build", async () => {
    queued("poison", null);
    queued("next");
    expect(await drainCloudBuildQueue("w")).toEqual({ started: 1 });
    expect(h.fail).toHaveBeenCalledWith({
      deploymentId: "poison",
      buildSessionId: "session-poison",
      projectId: "p",
      organizationId: "org",
      errorCode: "DEPLOYMENT_CONFIG_MISSING",
      errorMessage: expect.any(String),
    });
    expect(h.rows.get("poison")!.status).toBe("failed");
    expect(h.rows.get("next")!.status).toBe("building");
  });
  it.each([
    new AppError("invalid allocation", 409, "CLOUD_WORKSPACE_BUILD_CAPACITY"),
    new AppError("forbidden", 403, "FORBIDDEN"),
    new AppError("plan required", 402, "PLAN_UPGRADE_REQUIRED"),
  ])("settles permanent rejection %s", async (error) => {
    queued("a");
    h.kickoff.mockRejectedValue(error);
    expect(await drainCloudBuildQueue()).toEqual({ started: 0 });
    expect(h.fail).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: "a", errorCode: error.code }),
    );
  });
  it.each([
    new Error("read failed"),
    new AppError("unavailable", 503, "UNAVAILABLE"),
    new AppError("busy", 409, "CLOUD_WORKSPACE_BUSY"),
    new AppError("activity changed", 409, "CLOUD_BUILD_ACTIVITY_CHANGED"),
  ])("does not permanently fail retryable dispatch %s", async (error) => {
    queued("a");
    h.kickoff.mockRejectedValue(error);
    expect(await drainCloudBuildQueue()).toEqual({ started: 0 });
    expect(h.fail).not.toHaveBeenCalled();
    expect(h.rows.get("a")!.status).toBe("queued");
  });
  it("snapshots all pages before dispatch mutates FIFO offsets", async () => {
    for (let i = 0; i < 201; i++) queued(String(i), { releaseImageRef: "image:v1" });
    expect(await drainCloudBuildQueue("w")).toEqual({ started: 201 });
    expect(h.list).toHaveBeenNthCalledWith(1, "w", 200, 0);
    expect(h.list).toHaveBeenNthCalledWith(2, "w", 200, 200);
    expect(h.kickoff).toHaveBeenCalledTimes(201);
    expect(h.list.mock.invocationCallOrder[1]).toBeLessThan(h.kickoff.mock.invocationCallOrder[0]!);
  });
  it("does no scanning in selfhost", async () => {
    h.cloud = false;
    expect(await drainCloudBuildQueue()).toEqual({ started: 0 });
    expect(h.list).not.toHaveBeenCalled();
  });
  it.each([408, 425, 429])("keeps transient provider HTTP %s queued", async (status) => {
    queued("a");
    h.sample.mockRejectedValue(
      new AppError("provider temporarily unavailable", status, "PROVIDER_RETRY"),
    );
    await drainCloudBuildQueue("w");
    expect(h.fail).not.toHaveBeenCalled();
    expect(h.rows.get("a")!.status).toBe("queued");
  });
  it("a failed rejection write does not abort the rest of the sweep", async () => {
    queued("poison", null);
    queued("next");
    h.fail.mockRejectedValueOnce(new Error("write unavailable"));
    await drainCloudBuildQueue();
    expect(h.kickoff).toHaveBeenCalledTimes(2);
  });
});
