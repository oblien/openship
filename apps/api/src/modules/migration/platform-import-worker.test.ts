import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@repo/core";
import { withProjectRuntimeLock } from "@repo/platform/engine/lib/project-runtime-lock";
import type { ExecutionContext } from "@repo/platform";
import type {
  PrivateImportPlan,
  PlannedImportService,
} from "@repo/platform/engine/modules/migration/platform-import-plan";
const h = vi.hoisted(() => ({
  ensure: vi.fn(),
  merge: vi.fn(),
  connect: vi.fn(),
  view: vi.fn(),
  deploy: vi.fn(),
  copy: vi.fn(),
  preflight: vi.fn(),
  prepareTarget: vi.fn(),
  authorize: vi.fn(),
  disable: vi.fn(),
  bind: vi.fn(),
  find: vi.fn(),
  checkpoint: vi.fn(),
  update: vi.fn(),
  prepareSource: vi.fn(),
  restoreSource: vi.fn(),
  verify: vi.fn(),
  events: [] as string[],
}));
vi.mock("@repo/db", () => ({
  withAdvisoryLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  repos: {
    project: { update: h.update, findById: async (id: string) => ({ id, workspaceId: null }) },
    dockerMigrationRun: {
      bindImportedProject: h.bind,
      findById: h.find,
      updateRecovery: h.checkpoint,
    },
  },
}));
vi.mock("@repo/platform/engine/modules/projects/project-crud.service", () => ({
  ensureProject: h.ensure,
}));
vi.mock("@repo/platform/engine/modules/projects/project-env.service", () => ({
  mergeEnvVars: h.merge,
}));
vi.mock("@repo/platform/engine/modules/projects/project-connection.service", () => ({
  createConnection: h.connect,
}));
vi.mock("@repo/platform/engine/modules/projects/project-runtime.service", () => ({
  disableProject: h.disable,
}));
vi.mock("@repo/platform/engine/modules/apps/app-settings.service", () => ({
  getAppConnectionView: h.view,
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  triggerDeployment: h.deploy,
}));
vi.mock("@repo/platform/engine/modules/migration/platform-import-data", () => ({
  copyPlatformData: h.copy,
  preflightPlatformData: h.preflight,
}));
vi.mock("@repo/platform/engine/modules/migration/migration-runtime", () => ({
  prepareMigrationTarget: h.prepareTarget,
}));
vi.mock("@repo/platform/engine/modules/migration/platform-import-health", () => ({
  verifyPlatformDeployment: h.verify,
}));
vi.mock("@repo/platform/engine/lib/authorization", () => ({
  authorization: { authorize: h.authorize },
}));
vi.mock("@repo/platform/engine/modules/migration/providers/railway-project-transfer", () => ({
  prepareRailwayProjectTransfer: h.prepareSource,
  restoreRailwayProjectTransfer: h.restoreSource,
}));
vi.mock("@repo/platform/engine/lib/encryption", () => ({ decrypt: (s: string) => s }));
import {
  executePlatformImport,
  orderedImports,
  pauseFailedPlatformImport,
} from "@repo/platform/engine/modules/migration/platform-import-worker";

const ctx = { organizationId: "org", userId: "user" } as ExecutionContext;
const service = (id: string, kind: "app" | "database" | "worker"): PlannedImportService => ({
  source: {
    id,
    name: id,
    kind,
    image: "image:1",
    env: {},
    rawEnv: {},
    variables: [],
    domains: [],
    warnings: [],
    blockers: [],
    volumes: [{ id: "data", mountPath: "/data" }],
    ...(kind === "database" ? { database: "pg_dump" } : { commit: "a".repeat(40), branch: "main" }),
  },
  data: "copy",
  create: { name: id },
  environment: { TOKEN: "secret" },
  bindings: [],
});
const planFor = (services: PlannedImportService[]) =>
  ({
    id: "plan",
    organizationId: "org",
    userId: "user",
    targetServerId: "server",
    services,
  }) as PrivateImportPlan;
let row: any;
beforeEach(() => {
  vi.resetAllMocks();
  h.events.length = 0;
  row = {
    id: "run",
    organizationId: "org",
    recovery: {
      providerImport: { projects: {}, completed: [], deployments: {}, cleanupPending: true },
    },
  };
  h.find.mockImplementation(async () => structuredClone(row));
  h.checkpoint.mockImplementation(async (_id, patch) => {
    Object.assign(row.recovery, patch);
  });
  h.bind.mockImplementation(async (_run, _org, sourceId, projectId) => {
    row.recovery.providerImport.projects[sourceId] = projectId;
    return true;
  });
  h.ensure.mockImplementation(async (body) => {
    h.events.push(`create:${body.name}`);
    return { project_id: body.name };
  });
  h.deploy.mockImplementation(async (_ctx, input) => {
    h.events.push(`deploy:${input.projectId}`);
    return { deployment: { id: `${input.projectId}-build` } };
  });
  h.copy.mockImplementation(async (input) => {
    h.events.push(`copy:${input.projectId}`);
  });
  h.view.mockResolvedValue({
    outputs: [{ id: "database-url", internal: true, value: "postgres://new" }],
  });
  h.prepareSource.mockImplementation(async () => {
    h.events.push("pause-project");
  });
  h.restoreSource.mockImplementation(async (_run, resume) => {
    h.events.push(resume ? "resume-project" : "restore-config");
  });
});
const lifecycle = (signal = new AbortController().signal) => ({
  signal,
  log: vi.fn(),
  progress: vi.fn(),
  phase: vi.fn(),
  wait: vi.fn(async (id: string) => {
    h.events.push(`healthy:${id}`);
    return true;
  }),
});
describe("provider import through normal project operations", () => {
  it("prepares managed capacity before pausing Railway and does not stop the source if provisioning fails", async () => {
    const plan = { ...planFor([service("app", "app")]), sourceControl: "railway-project" as const };
    const flow = lifecycle();
    h.prepareTarget.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(executePlatformImport(ctx, "run", plan, flow)).rejects.toThrow(
      "provider unavailable",
    );
    expect(h.prepareTarget).toHaveBeenCalledWith("org", "server", "run", {
      signal: flow.signal,
      onProgress: flow.log,
    });
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.prepareSource).not.toHaveBeenCalled();
    expect(h.copy).not.toHaveBeenCalled();
  });
  it("copies the entire Railway project's volumes before starting any destination, regardless of service type", async () => {
    const services = [
      service("db", "database"),
      service("custom-store", "app"),
      service("jobs", "worker"),
    ];
    for (const entry of services) entry.transfer = "cold-volume";
    const plan = { ...planFor(services), sourceControl: "railway-project" as const };
    await executePlatformImport(ctx, "run", plan, lifecycle());
    expect(h.prepareSource).toHaveBeenCalledTimes(1);
    expect(h.prepareTarget).toHaveBeenCalledTimes(1);
    expect(h.prepareTarget.mock.invocationCallOrder[0]).toBeLessThan(
      h.prepareSource.mock.invocationCallOrder[0],
    );
    const firstDeployment = h.events.findIndex((e) => e.startsWith("deploy:"));
    for (const entry of services)
      expect(h.events.indexOf(`copy:${entry.source.id}`)).toBeLessThan(firstDeployment);
    expect(h.events.indexOf("pause-project")).toBeLessThan(h.events.indexOf("copy:db"));
    expect(h.events.indexOf("restore-config")).toBeLessThan(firstDeployment);
    expect(h.copy.mock.calls.every(([input]) => input.deploymentId === undefined)).toBe(true);
  });
  it("stops every imported Railway workload before resuming the source on failure", async () => {
    const plan = {
      ...planFor([service("app", "app"), service("db", "database")]),
      sourceControl: "railway-project",
    };
    Object.assign(row.recovery.providerImport, {
      planEnc: JSON.stringify(plan),
      projects: { app: "p-app", db: "p-db" },
      deployments: { app: "app-build", db: "db-build" },
    });
    h.disable.mockImplementation(async (id) => {
      h.events.push(`stop:${id}`);
    });
    await pauseFailedPlatformImport("run");
    expect(h.events).toEqual(["stop:p-app", "stop:p-db", "resume-project"]);
  });
  it("restores databases before consumers, files before app startup, and workers last", async () => {
    const db = service("db", "database"),
      app = service("app", "app"),
      worker = service("worker", "worker");
    app.bindings = [{ sourceId: "db", envKey: "DATABASE_URL" }];
    const plan = planFor([worker, app, db]);
    await executePlatformImport(ctx, "run", plan, lifecycle());
    expect(h.events).toEqual([
      "create:db",
      "create:app",
      "create:worker",
      "deploy:db",
      "healthy:db-build",
      "copy:db",
      "copy:app",
      "deploy:app",
      "healthy:app-build",
      "copy:worker",
      "deploy:worker",
      "healthy:worker-build",
    ]);
    expect(h.ensure).toHaveBeenCalledWith(app.create, "org", ctx, { mustCreate: true });
    expect(h.connect).toHaveBeenCalledWith(
      ctx,
      "app",
      { sourceProjectId: "db", outputId: "database-url", envKey: "DATABASE_URL", mode: "internal" },
      { defer: true },
    );
    expect(h.deploy).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ projectId: "app", commitSha: "a".repeat(40), branch: "main" }),
    );
    expect(row.recovery.providerImport.completed).toEqual(["db", "app", "worker"]);
  });
  it("does not launch consumers when a database copy fails", async () => {
    h.copy.mockRejectedValue(new Error("restore failed"));
    const app = service("app", "app");
    app.bindings = [{ sourceId: "db", envKey: "URL" }];
    await expect(
      executePlatformImport(ctx, "run", planFor([app, service("db", "database")]), lifecycle()),
    ).rejects.toThrow("restore failed");
    expect(h.deploy).toHaveBeenCalledTimes(1);
    expect(h.deploy).toHaveBeenCalledWith(ctx, expect.objectContaining({ projectId: "db" }));
  });
  it("checkpoints the created deployment before observing a cancelled phase", async () => {
    const flow = lifecycle();
    flow.phase.mockImplementation(async (status) => {
      if (status === "verifying") throw new Error("cancelled");
    });
    await expect(
      executePlatformImport(ctx, "run", planFor([service("app", "app")]), flow),
    ).rejects.toThrow("cancelled");
    expect(row.recovery.providerImport.deployments).toEqual({ app: "app-build" });
  });
  it("rejects dependency cycles rather than starting a partial recursive import", () => {
    const a = service("a", "app"),
      b = service("b", "app");
    a.bindings = [{ sourceId: "b", envKey: "URL" }];
    b.bindings = [{ sourceId: "a", envKey: "URL" }];
    expect(() => orderedImports([a, b])).toThrow(/cycle/);
  });
  it("retains databases and pauses only the import's own app deployment identities on failure", async () => {
    const plan = planFor([service("app", "app"), service("db", "database")]);
    Object.assign(row.recovery.providerImport, {
      planEnc: JSON.stringify(plan),
      projects: { app: "p-app", db: "p-db" },
      deployments: { app: "app-build", db: "db-build" },
    });
    await pauseFailedPlatformImport("run");
    expect(h.disable).toHaveBeenCalledExactlyOnceWith("p-app", "org", "app-build");
    expect(row.recovery.providerImport.cleanupPending).toBe(false);
  });
  it("leaves the cleanup checkpoint pending if the destination cannot be reached", async () => {
    Object.assign(row.recovery.providerImport, {
      planEnc: JSON.stringify(planFor([service("app", "app")])),
      projects: { app: "p-app" },
      deployments: { app: "app-build" },
    });
    h.disable.mockRejectedValue(new Error("offline"));
    await expect(pauseFailedPlatformImport("run")).rejects.toThrow("offline");
    expect(row.recovery.providerImport.cleanupPending).toBe(true);
    expect(h.restoreSource).not.toHaveBeenCalled();
  });
  it("keeps Railway paused and recovery pending when an operator replaces a destination deployment", async () => {
    const plan = {
      ...planFor([service("app", "app")]),
      sourceControl: "railway-project",
    };
    Object.assign(row.recovery.providerImport, {
      planEnc: JSON.stringify(plan),
      projects: { app: "p-app" },
      deployments: { app: "app-build" },
    });
    h.disable.mockRejectedValue(
      new AppError("The active deployment changed", 409, "DEPLOYMENT_NOT_ACTIVE"),
    );

    await expect(pauseFailedPlatformImport("run")).rejects.toMatchObject({
      code: "DEPLOYMENT_NOT_ACTIVE",
    });
    expect(h.disable).toHaveBeenCalledExactlyOnceWith("p-app", "org", "app-build");
    expect(h.restoreSource).not.toHaveBeenCalled();
    expect(row.recovery.providerImport.cleanupPending).toBe(true);
    expect(row.recovery.providerImport.planEnc).toBe(JSON.stringify(plan));
  });
  it("holds the normal destination runtime lock until Railway recovery finishes", async () => {
    Object.assign(row.recovery.providerImport, {
      planEnc: JSON.stringify({
        ...planFor([service("app", "app")]),
        sourceControl: "railway-project",
      }),
      projects: { app: "p-app" },
      deployments: { app: "app-build" },
    });
    let signalStarted!: () => void;
    let releaseRecovery!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    h.restoreSource.mockImplementation(async () => {
      h.events.push("resume-start");
      signalStarted();
      await release;
      h.events.push("resume-finished");
    });
    const recovery = pauseFailedPlatformImport("run");
    await started;
    const operator = withProjectRuntimeLock("p-app", async () => {
      h.events.push("operator-start");
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.events).toEqual(["resume-start"]);
    } finally {
      releaseRecovery();
      await Promise.all([recovery, operator]);
    }
    expect(h.events).toEqual(["resume-start", "resume-finished", "operator-start"]);
  });
});

it("checks all source data before creating any destination projects", async () => {
  h.preflight.mockRejectedValue(new Error("source unavailable"));
  await expect(
    executePlatformImport(ctx, "run", planFor([service("db", "database")]), lifecycle()),
  ).rejects.toThrow("source unavailable");
  expect(h.ensure).not.toHaveBeenCalled();
  expect(h.deploy).not.toHaveBeenCalled();
});
