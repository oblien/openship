import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #589: adding a compose service to a project whose `framework` is "unknown"
 * materialized a slug-named `kind:"monorepo"` app row with no image and no build
 * recipe. `getProjectType()` was the only gate, and it answers "what shape is
 * this stack" — every category but `docker`/`services` maps to "app", including
 * the `generic` category that holds the `unknown` stack. So the guard admitted
 * exactly the projects it claimed to exempt: service-first ones, which store
 * `framework: "unknown"` deliberately (project-crud's createServicesProject) or
 * get it by omission on create.
 *
 * The row was then undeployable in a way that escalated: the compose builder puts
 * it in neither the buildable nor the external-image bucket, so deploy #1 fails
 * with `No image available for service "<slug>"` — and that failure PERSISTS a
 * service_deployment row, flipping `everDeployed` true and disqualifying the row
 * from preflight's dead-row carve-out, so deploy #2 onward is refused outright.
 *
 * Both directions are covered here, and both callers: the create endpoint and the
 * boot reconcile (which is the only path that reaches docker-migration-adopted
 * projects — their compose rows are written directly by the import, so they never
 * call createService at all).
 */

const projectRepo = vi.hoisted(() => ({ findById: vi.fn(), listAllForScan: vi.fn() }));
const serviceRepo = vi.hoisted(() => ({
  listByProject: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}));
const domainRepo = vi.hoisted(() => ({ listByProject: vi.fn() }));
const serviceDeploymentRepo = vi.hoisted(() => ({ listByService: vi.fn() }));
const startupHooks = vi.hoisted(() => ({ registered: [] as Array<{ id: string; run: () => Promise<void> }> }));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: projectRepo,
      service: serviceRepo,
      domain: domainRepo,
      serviceDeployment: serviceDeploymentRepo,
    },
  };
});

vi.mock("../../../src/lib/startup", () => ({
  registerStartupHook: (hook: { id: string; run: () => Promise<void> }) => {
    startupHooks.registered.push(hook);
  },
}));

import {
  createService,
  isMaterializedAppRow,
  registerAppServiceRowReconcile,
} from "../../../src/modules/services/service.service";
import { hasSourceBuildRecipe } from "../../../src/lib/deployable-service";

const ctx = { organizationId: "org_1" } as never;

/** A project as `createServicesProject` / a framework-less create actually stores it. */
const unknownProject = (over: Record<string, unknown> = {}) => ({
  id: "proj_1",
  organizationId: "org_1",
  slug: "my-stack",
  framework: "unknown",
  packageManager: "npm",
  buildCommand: null,
  startCommand: null,
  installCommand: null,
  rootDirectory: null,
  appTemplateId: null,
  port: 3000,
  hasServer: true,
  hasBuild: false,
  workloadType: "web",
  ...over,
});

/** A real app-framework project — the #231 case that must keep working. */
const appProject = (over: Record<string, unknown> = {}) =>
  unknownProject({
    framework: "nextjs",
    buildCommand: "npm run build",
    startCommand: "npm start",
    hasBuild: true,
    ...over,
  });

const composeRow = (over: Record<string, unknown> = {}) => ({
  id: "svc_db",
  projectId: "proj_1",
  name: "postgres",
  kind: "compose",
  image: "postgres:16-alpine",
  enabled: true,
  sortOrder: 0,
  ...over,
});

/** The exact row the materializer writes. */
const phantomRow = (over: Record<string, unknown> = {}) => ({
  id: "svc_phantom",
  projectId: "proj_1",
  name: "my-stack",
  kind: "monorepo",
  sortOrder: -1,
  enabled: true,
  image: null,
  build: null,
  dockerfile: null,
  framework: null,
  installCommand: null,
  buildCommand: null,
  startCommand: null,
  outputDirectory: null,
  rootDirectory: ".",
  ...over,
});

const composeBody = (over: Record<string, unknown> = {}) =>
  ({ name: "postgres", kind: "compose", image: "postgres:16-alpine", ...over }) as never;

/** Requesting a SECOND sidecar — `composeRow()` already occupies "postgres", and
 *  validateServiceName rejects a name that collides with a sibling. */
const secondComposeBody = () => composeBody({ name: "redis", image: "redis:7" });

/**
 * Stateful, because the sequence is the whole point: createService INSERTS the
 * sidecar and the reconciler then re-reads the project's rows and sees it. A
 * `listByProject` stub frozen at `[]` would report no sidecar, which is the one
 * condition under which even the unfixed code declined to materialize — the test
 * would pass against the bug.
 */
let rows: Array<Record<string, unknown>> = [];

/** Pre-existing rows, as they were on disk before the call under test. */
const seed = (...initial: Array<Record<string, unknown>>) => {
  rows = [...initial];
};

beforeEach(() => {
  rows = [];
  projectRepo.findById.mockReset();
  projectRepo.listAllForScan.mockReset().mockResolvedValue([]);
  serviceRepo.listByProject.mockReset().mockImplementation(async () => rows);
  serviceRepo.create.mockReset().mockImplementation(async (row: Record<string, unknown>) => {
    const created = { id: `svc_new_${rows.length}`, ports: [], environment: {}, ...row };
    rows.push(created);
    return created;
  });
  serviceRepo.remove.mockReset().mockImplementation(async (id: string) => {
    rows = rows.filter((row) => row.id !== id);
  });
  domainRepo.listByProject.mockReset().mockResolvedValue([]);
  serviceDeploymentRepo.listByService.mockReset().mockResolvedValue([]);
  startupHooks.registered.length = 0;
});

/** Every `create` call that wrote an app row (kind monorepo), ignoring the requested service. */
const materializedRows = () =>
  serviceRepo.create.mock.calls
    .map(([row]) => row as Record<string, unknown>)
    .filter((row) => row.kind === "monorepo");

describe("hasSourceBuildRecipe", () => {
  it.each([
    ["a build command", { framework: "nextjs", buildCommand: "npm run build", startCommand: null }, true],
    ["a start command only", { framework: "express", buildCommand: null, startCommand: "node index.js" }, true],
    ["a Dockerfile stack", { framework: "docker", buildCommand: null, startCommand: null }, true],
    ["the unknown stack with nothing", { framework: "unknown", buildCommand: null, startCommand: null }, false],
    ["empty-string commands", { framework: "unknown", buildCommand: "", startCommand: "" }, false],
    ["no framework at all", { framework: null, buildCommand: null, startCommand: null }, false],
  ])("%s → %s", (_label, input, expected) => {
    expect(hasSourceBuildRecipe(input)).toBe(expected);
  });
});

describe("isMaterializedAppRow", () => {
  const project = { slug: "my-stack" };

  it("matches the row the materializer writes", () => {
    expect(isMaterializedAppRow(project, phantomRow() as never)).toBe(true);
  });

  it("still matches after an operator disables it (the common #589 workaround)", () => {
    expect(isMaterializedAppRow(project, phantomRow({ enabled: false }) as never)).toBe(true);
  });

  it.each([
    ["a different name", { name: "web" }],
    ["a compose row", { kind: "compose" }],
    ["an operator sortOrder", { sortOrder: 0 }],
    ["a pinned image", { image: "ghcr.io/acme/web:1" }],
    ["a Dockerfile context", { build: "./apps/web" }],
    ["its own framework", { framework: "nextjs" }],
    ["a build command", { buildCommand: "npm run build" }],
    ["a start command", { startCommand: "npm start" }],
    ["an install command", { installCommand: "npm ci" }],
    ["an output directory", { outputDirectory: "dist" }],
  ])("does not match a row with %s", (_label, over) => {
    expect(isMaterializedAppRow(project, phantomRow(over) as never)).toBe(false);
  });
});

describe("createService → app-row materialization (#589)", () => {
  it("does not materialize an app row for an unknown/generic-framework project", async () => {
    projectRepo.findById.mockResolvedValue(unknownProject());

    await createService(ctx, "proj_1", composeBody());

    expect(materializedRows()).toEqual([]);
  });

  it("does not materialize one for a service-first project that already has sidecars", async () => {
    projectRepo.findById.mockResolvedValue(unknownProject());
    seed(composeRow());

    await createService(ctx, "proj_1", secondComposeBody());

    expect(materializedRows()).toEqual([]);
  });

  it("still materializes one for a real app-framework project (#231 preserved)", async () => {
    projectRepo.findById.mockResolvedValue(appProject());
    // The sidecar exists by the time the helper runs — createService inserted it.
    seed(composeRow());

    await createService(ctx, "proj_1", secondComposeBody());

    const [row] = materializedRows();
    expect(row).toMatchObject({ name: "my-stack", kind: "monorepo", enabled: true, sortOrder: -1 });
    // Build fields stay null so the row inherits the project snapshot.
    expect(row.buildCommand).toBeUndefined();
    expect(row.image).toBeUndefined();
  });

  it("does not materialize a second app row when one already exists", async () => {
    projectRepo.findById.mockResolvedValue(appProject());
    seed(composeRow(), phantomRow());

    await createService(ctx, "proj_1", secondComposeBody());

    expect(materializedRows()).toEqual([]);
  });

  it("leaves a static project alone (#538-B)", async () => {
    projectRepo.findById.mockResolvedValue(
      appProject({ workloadType: "static", hasServer: false, startCommand: null }),
    );
    seed(composeRow());

    await createService(ctx, "proj_1", secondComposeBody());

    expect(materializedRows()).toEqual([]);
    expect(serviceRepo.remove).not.toHaveBeenCalled();
  });

  it("leaves a catalog app alone", async () => {
    projectRepo.findById.mockResolvedValue(appProject({ appTemplateId: "tpl_ghost" }));
    seed(composeRow());

    await createService(ctx, "proj_1", secondComposeBody());

    expect(materializedRows()).toEqual([]);
  });

  it("never blocks the requested service — the row is still created and returned", async () => {
    projectRepo.findById.mockResolvedValue(unknownProject());
    seed();

    const created = await createService(ctx, "proj_1", composeBody());

    expect(created).toMatchObject({ name: "postgres", kind: "compose" });
  });
});

describe("boot reconcile → phantom repair (#589)", () => {
  /** Run the registered backfill hook, which is the only path that reaches
   *  migration-adopted projects (they never call createService). */
  const runBackfill = async () => {
    registerAppServiceRowReconcile();
    const hook = startupHooks.registered.find(
      (h) => h.id === "services:reconcile-app-row",
    );
    expect(hook, "backfill hook was not registered").toBeDefined();
    await hook!.run();
  };

  it("removes a phantom row from a project with no build recipe", async () => {
    projectRepo.listAllForScan.mockResolvedValue([unknownProject()]);
    seed(composeRow(), phantomRow());

    await runBackfill();

    expect(serviceRepo.remove).toHaveBeenCalledWith("svc_phantom");
    expect(materializedRows()).toEqual([]);
  });

  it("removes it even with no sidecar left to pair against", async () => {
    projectRepo.listAllForScan.mockResolvedValue([unknownProject()]);
    seed(phantomRow());

    await runBackfill();

    expect(serviceRepo.remove).toHaveBeenCalledWith("svc_phantom");
  });

  it("does NOT remove a row that once deployed successfully", async () => {
    projectRepo.listAllForScan.mockResolvedValue([unknownProject()]);
    seed(composeRow(), phantomRow());
    serviceDeploymentRepo.listByService.mockResolvedValue([
      { serviceId: "svc_phantom", status: "failure" },
      { serviceId: "svc_phantom", status: "success" },
    ]);

    await runBackfill();

    expect(serviceRepo.remove).not.toHaveBeenCalled();
  });

  it("removes it despite the failure rows its own deploys wrote", async () => {
    projectRepo.listAllForScan.mockResolvedValue([unknownProject()]);
    seed(composeRow(), phantomRow());
    serviceDeploymentRepo.listByService.mockResolvedValue([
      { serviceId: "svc_phantom", status: "failure" },
    ]);

    await runBackfill();

    expect(serviceRepo.remove).toHaveBeenCalledWith("svc_phantom");
  });

  it("does NOT remove an operator's own monorepo sub-app", async () => {
    projectRepo.listAllForScan.mockResolvedValue([unknownProject()]);
    seed(
      composeRow(),
      phantomRow({ id: "svc_web", name: "web", sortOrder: 2, startCommand: "npm start" }),
    );

    await runBackfill();

    expect(serviceRepo.remove).not.toHaveBeenCalled();
  });

  it("leaves a real app-framework project's app row in place", async () => {
    projectRepo.listAllForScan.mockResolvedValue([appProject()]);
    seed(composeRow(), phantomRow());

    await runBackfill();

    expect(serviceRepo.remove).not.toHaveBeenCalled();
    expect(materializedRows()).toEqual([]);
  });

  it("still backfills a missing app row for a real app project (#231)", async () => {
    projectRepo.listAllForScan.mockResolvedValue([appProject()]);
    seed(composeRow());

    await runBackfill();

    expect(materializedRows()).toHaveLength(1);
    expect(serviceRepo.remove).not.toHaveBeenCalled();
  });

  it("is idempotent — a second pass neither re-creates nor re-deletes", async () => {
    projectRepo.listAllForScan.mockResolvedValue([unknownProject()]);
    seed(composeRow(), phantomRow());
    await runBackfill();
    expect(serviceRepo.remove).toHaveBeenCalledTimes(1);

    // The row is gone on the next boot.
    seed(composeRow());
    await runBackfill();

    expect(serviceRepo.remove).toHaveBeenCalledTimes(1);
    expect(materializedRows()).toEqual([]);
  });
});
