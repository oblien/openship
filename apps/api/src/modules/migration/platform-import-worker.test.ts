import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, ConflictError } from "@repo/core";
import { withProjectRuntimeLock } from "@repo/platform/engine/lib/project-runtime-lock";
import type { ExecutionContext } from "@repo/platform";
import type {
  PrivateImportPlan,
  PlannedImportService,
} from "@repo/platform/engine/modules/migration/platform-import-plan";
import { platformImportProject } from "@repo/platform/engine/modules/migration/platform-import-project";
const h = vi.hoisted(() => ({
  ensure: vi.fn(),
  merge: vi.fn(),
  list: vi.fn(),
  project: vi.fn(),
  sourceService: vi.fn(),
  rows: [] as Array<{ id: string; projectId: string; name: string }>,
  view: vi.fn(),
  deploy: vi.fn(),
  copy: vi.fn(),
  preflight: vi.fn(),
  prepareTarget: vi.fn(),
  routes: vi.fn(),
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
    service: { listByProject: h.list },
    project: { update: h.update, findById: h.project },
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
vi.mock("@repo/platform/engine/modules/services/service-environment-state", () => ({
  mergeServiceEnvVars: h.merge,
}));
vi.mock("@repo/platform/engine/modules/services/service.service", () => ({
  createService: h.sourceService,
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
vi.mock("@repo/platform/engine/modules/migration/migration-routes", () => ({
  saveMigrationRoutes: h.routes,
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
  create: {
    name: id,
    internalAlias: id,
    services: [{ name: id, image: "image:1", volumes: [`${id}-data:/data`] }],
  },
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
    project: platformImportProject("imported-project", "server", services),
  }) as PrivateImportPlan;
let row: any;
beforeEach(() => {
  vi.resetAllMocks();
  h.events.length = 0;
  h.rows.length = 0;
  h.routes.mockResolvedValue([]);
  h.project.mockImplementation(async (id) => ({ id, workspaceId: null }));
  h.list.mockImplementation(async (projectId) =>
    h.rows.filter((row) => row.projectId === projectId),
  );
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
    h.rows.push(
      ...body.services.map((row: { name: string }) => ({
        ...row,
        id: `${body.name}-${row.name}`,
        projectId: body.name,
      })),
    );
    return { project_id: body.name };
  });
  h.sourceService.mockImplementation(async (_ctx, projectId, body) => {
    h.rows.push({ ...body, id: `${projectId}-${body.name}`, projectId });
  });
  let deploymentCount = 0;
  h.deploy.mockImplementation(async (_ctx, input) => {
    h.events.push(`deploy:${input.projectId}:${input.serviceIds.length}`);
    return { deployment: { id: `${input.projectId}-build-${++deploymentCount}` } };
  });
  h.copy.mockImplementation(async (input) => {
    h.events.push(`copy:${input.service.source.id}`);
  });
  h.view.mockImplementation(async () => ({
    outputs: h.rows.map((row) => ({
      id: `${row.id}:url`,
      sourceServiceId: row.id,
      internal: true,
      value: "postgres://new",
    })),
  }));
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
  it("stages custom domains through native migration routing before pausing the source", async () => {
    const web = service("web", "app");
    web.create.name = "storefront";
    web.source.domains = [
      { hostname: "shop.example.com", portable: true },
      { hostname: "www.example.com", portable: true },
      { hostname: "shop.up.railway.app", portable: false },
    ];
    const plan = { ...planFor([web]), sourceControl: "railway-project" as const };
    const flow = lifecycle();
    await executePlatformImport(ctx, "run", plan, flow);
    expect(h.routes).toHaveBeenCalledWith(
      ctx,
      "imported-project",
      {
        storefront: [
          { domainType: "custom", customDomain: "shop.example.com" },
          { domainType: "custom", customDomain: "www.example.com" },
        ],
      },
      flow.log,
    );
    expect(h.routes.mock.invocationCallOrder[0]).toBeLessThan(
      h.prepareSource.mock.invocationCallOrder[0],
    );
    expect(h.routes.mock.invocationCallOrder[0]).toBeLessThan(h.copy.mock.invocationCallOrder[0]);
  });

  it("reports domain conflicts without pausing Railway or deploying the destination", async () => {
    const app = service("app", "app");
    app.source.domains = [{ hostname: "taken.example.com", portable: true }];
    h.routes.mockRejectedValueOnce(
      new ConflictError("The domain is already connected to another project."),
    );
    await expect(
      executePlatformImport(
        ctx,
        "run",
        {
          ...planFor([app]),
          sourceControl: "railway-project",
        },
        lifecycle(),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "IMPORT_DOMAIN_REVIEW_REQUIRED",
      message: "The domain is already connected to another project.",
    });
    expect(h.prepareSource).not.toHaveBeenCalled();
    expect(h.copy).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
  });

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
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.deploy).toHaveBeenCalledTimes(1);
    expect(new Set(h.copy.mock.calls.map(([input]) => input.projectId))).toEqual(
      new Set(["imported-project"]),
    );
    expect(new Set(h.copy.mock.calls.map(([input]) => input.serviceId)).size).toBe(3);
    expect(new Set(Object.values(row.recovery.providerImport.projects))).toEqual(
      new Set(["imported-project"]),
    );
  });
  it("imports two source projects as two native projects, keeping identical service names separate", async () => {
    for (const name of ["first-project", "second-project"]) {
      const services = [service("db", "database"), service("app", "app")];
      services.forEach((service) => (service.transfer = "cold-volume"));
      const plan = { ...planFor(services), sourceControl: "railway-project" as const };
      plan.project.name = name;
      await executePlatformImport(ctx, name, plan, lifecycle());
      expect(new Set(Object.values(row.recovery.providerImport.projects))).toEqual(new Set([name]));
    }
    expect(h.ensure.mock.calls.map(([body]) => body.name)).toEqual([
      "first-project",
      "second-project",
    ]);
    expect(h.rows.map((row) => row.projectId)).toEqual([
      "first-project",
      "first-project",
      "second-project",
      "second-project",
    ]);
    expect(h.copy.mock.calls.map(([input]) => [input.projectId, input.serviceId])).toEqual([
      ["first-project", "first-project-db"],
      ["first-project", "first-project-app"],
      ["second-project", "second-project-db"],
      ["second-project", "second-project-app"],
    ]);
  });
  it("stores each service's environment separately instead of merging it into project-wide values", async () => {
    const app = service("app", "app"),
      db = service("db", "database");
    app.environment = { PORT: "3000", TOKEN: "app-secret" };
    db.environment = { PORT: "5432", TOKEN: "database-secret" };
    await executePlatformImport(ctx, "run", planFor([app, db]), lifecycle());
    for (const entry of [app, db]) {
      expect(h.merge).toHaveBeenCalledWith(
        ctx,
        "imported-project",
        `imported-project-${entry.source.id}`,
        {
          environment: "production",
          deletes: [],
          upserts: Object.entries(entry.environment).map(([key, value]) => ({
            key,
            value,
            isSecret: true,
            sourceId: null,
          })),
        },
      );
    }
  });
  it("adds a source-built app through the native service creator in the same project", async () => {
    const app = service("app", "app");
    app.create = {
      name: "app",
      gitOwner: "owner",
      gitRepo: "repo",
      gitBranch: "main",
      framework: "nextjs",
      rootDirectory: "apps/web",
      installCommand: "bun install",
      startCommand: "bun start",
      port: 3000,
    };
    await executePlatformImport(ctx, "run", planFor([app, service("db", "database")]), lifecycle());
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.sourceService).toHaveBeenCalledWith(
      ctx,
      "imported-project",
      expect.objectContaining({
        name: "app",
        kind: "monorepo",
        rootDirectory: "apps/web",
        framework: "nextjs",
        ports: ["3000"],
        exposed: false,
      }),
    );
    expect(h.deploy).toHaveBeenLastCalledWith(
      ctx,
      expect.objectContaining({
        projectId: "imported-project",
        commitSha: "a".repeat(40),
      }),
    );
  });
  it("rejects reviews from the old per-service-project flow before allocating a destination", async () => {
    const plan = planFor([service("app", "app")]);
    delete (plan as Partial<PrivateImportPlan>).project;
    await expect(executePlatformImport(ctx, "run", plan, lifecycle())).rejects.toMatchObject({
      code: "IMPORT_REVIEW_EXPIRED",
    });
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.prepareSource).not.toHaveBeenCalled();
  });
  it("pauses a shared destination once before restoring the Railway source", async () => {
    const plan = planFor([service("app", "app"), service("db", "database")]);
    Object.assign(row.recovery.providerImport, {
      planEnc: JSON.stringify(plan),
      projects: { app: "shared-project", db: "shared-project" },
      deployments: { app: "shared-build", db: "shared-build" },
    });
    await pauseFailedPlatformImport("run");
    expect(h.disable).toHaveBeenCalledExactlyOnceWith("shared-project", "org", "shared-build");
    expect(h.restoreSource).toHaveBeenCalledTimes(1);
    expect(h.disable.mock.invocationCallOrder[0]).toBeLessThan(
      h.restoreSource.mock.invocationCallOrder[0],
    );
  });
  it("can pause its own database-only predecessor when a complete deployment fails", async () => {
    const plan = planFor([service("app", "app"), service("db", "database")]);
    Object.assign(row.recovery.providerImport, {
      planEnc: JSON.stringify(plan),
      projects: { app: "shared", db: "shared" },
      deployments: { app: "failed-build", db: "failed-build" },
      ownedDeploymentIds: ["database-build", "failed-build"],
    });
    h.project.mockResolvedValue({ id: "shared", activeDeploymentId: "database-build" });
    await pauseFailedPlatformImport("run");
    expect(h.disable).toHaveBeenCalledExactlyOnceWith("shared", "org", "database-build");
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
      "create:imported-project",
      "deploy:imported-project:1",
      "healthy:imported-project-build-1",
      "copy:db",
      "copy:app",
      "copy:worker",
      "deploy:imported-project:3",
      "healthy:imported-project-build-2",
    ]);
    expect(h.ensure).toHaveBeenCalledExactlyOnceWith(plan.project, "org", ctx, {
      mustCreate: true,
    });
    expect(h.merge).toHaveBeenCalledWith(
      ctx,
      "imported-project",
      "imported-project-app",
      expect.objectContaining({
        upserts: [{ key: "DATABASE_URL", value: "postgres://new", sourceId: null, isSecret: true }],
      }),
    );
    expect(h.deploy).toHaveBeenNthCalledWith(
      1,
      ctx,
      expect.objectContaining({
        projectId: "imported-project",
        serviceIds: ["imported-project-db"],
        strictServiceScope: true,
      }),
    );
    expect(h.deploy).toHaveBeenNthCalledWith(
      2,
      ctx,
      expect.objectContaining({
        projectId: "imported-project",
        serviceIds: ["imported-project-db", "imported-project-app", "imported-project-worker"],
        strictServiceScope: true,
      }),
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
    expect(h.deploy).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        projectId: "imported-project",
        serviceIds: ["imported-project-db"],
      }),
    );
  });
  it("checkpoints the created deployment before observing a cancelled phase", async () => {
    const flow = lifecycle();
    flow.phase.mockImplementation(async (status) => {
      if (status === "verifying") throw new Error("cancelled");
    });
    await expect(
      executePlatformImport(ctx, "run", planFor([service("app", "app")]), flow),
    ).rejects.toThrow("cancelled");
    expect(row.recovery.providerImport.deployments).toEqual({ app: "imported-project-build-1" });
  });
  it("rejects dependency cycles rather than starting a partial recursive import", () => {
    const a = service("a", "app"),
      b = service("b", "app");
    a.bindings = [{ sourceId: "b", envKey: "URL" }];
    b.bindings = [{ sourceId: "a", envKey: "URL" }];
    expect(() => orderedImports([a, b])).toThrow(/cycle/);
  });
  it("pauses imported deployment identities before releasing source recovery", async () => {
    const plan = planFor([service("app", "app"), service("db", "database")]);
    Object.assign(row.recovery.providerImport, {
      planEnc: JSON.stringify(plan),
      projects: { app: "p-app", db: "p-db" },
      deployments: { app: "app-build", db: "db-build" },
    });
    await pauseFailedPlatformImport("run");
    expect(h.disable).toHaveBeenCalledWith("p-app", "org", "app-build");
    expect(h.disable).toHaveBeenCalledWith("p-db", "org", "db-build");
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
