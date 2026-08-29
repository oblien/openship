import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GH-615: `POST /projects/:id/services/:serviceId/restart` ran a bare
 * `docker restart`. A container's environment is fixed when it is CREATED, so an
 * operator who changed an env var and then restarted got `{success:true}` and a
 * container still running the old value — a silent no-op, with nothing pointing
 * at the refresh deploy that actually applies config.
 *
 * The fix keeps restart a cheap bounce (recreating from here would turn it into a
 * container replacement — downtime, new private IP) and makes it REFUSE with 409
 * `SERVICE_CONFIG_STALE` when env drifted, naming the pending keys. `force`
 * bounces anyway, because a crash-looping container must stay bounceable.
 *
 * The drift anchor is the ACTIVE deployment's `createdAt`, shared with the
 * smart-redeploy router via `deployments/env-drift` — one definition, so the
 * refusal and the refresh it recommends can never disagree about what is stale.
 */

const projectRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  listEnvVarChangeMeta: vi.fn(),
}));
const deploymentRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serviceRepo = vi.hoisted(() => ({
  listByProject: vi.fn(),
  listByDeployment: vi.fn(),
  updateServiceDeployment: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: projectRepo,
      deployment: deploymentRepo,
      service: serviceRepo,
    },
  };
});

const mockRuntime = vi.hoisted(() => ({
  name: "docker",
  restart: vi.fn(),
  dispose: vi.fn(),
}));

// Spread the original: mocking this module by NAME with a single export makes
// every OTHER symbol service.service.ts imports from it undefined.
const resolveDeploymentRuntimeForRead = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/deployment-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/deployment-runtime")>();
  return { ...actual, resolveDeploymentRuntimeForRead };
});

const liveContainerIdWithRuntime = vi.hoisted(() => vi.fn());
vi.mock("../../../src/modules/services/service-container", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/modules/services/service-container")
  >();
  return { ...actual, liveContainerIdWithRuntime };
});

import { restartServiceContainer } from "../../../src/modules/services/service.service";
import {
  ServiceConfigStaleError,
  resolveStaleEnvKeysForService,
} from "../../../src/modules/deployments/env-drift";

const ctx = { organizationId: "org_1" } as never;

/** The active deployment went live here. Anything touched after is pending. */
const ANCHOR = new Date("2026-08-18T10:00:00Z");
const BEFORE_ANCHOR = new Date("2026-08-18T09:00:00Z");
const AFTER_ANCHOR = new Date("2026-08-18T11:00:00Z");

const project = {
  id: "proj_1",
  organizationId: "org_1",
  slug: "my-app",
  activeDeploymentId: "dep_1",
  isControlPlane: false,
};

const deployment = { id: "dep_1", projectId: "proj_1", environment: "production", meta: {} };

const service = { id: "svc_web", projectId: "proj_1", name: "web", enabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  projectRepo.findById.mockResolvedValue(project);
  deploymentRepo.findById.mockResolvedValue({ ...deployment, createdAt: ANCHOR });
  serviceRepo.listByProject.mockResolvedValue([service]);
  serviceRepo.listByDeployment.mockResolvedValue([
    { id: "sd_1", deploymentId: "dep_1", serviceId: "svc_web", containerId: "c_live_1" },
  ]);
  serviceRepo.updateServiceDeployment.mockResolvedValue(undefined);
  projectRepo.listEnvVarChangeMeta.mockResolvedValue([]);
  resolveDeploymentRuntimeForRead.mockResolvedValue({ runtime: mockRuntime, serverId: null });
  liveContainerIdWithRuntime.mockResolvedValue("c_live_1");
  mockRuntime.restart.mockResolvedValue(undefined);
  mockRuntime.dispose.mockResolvedValue(undefined);
});

describe("GH-615 restart refuses to silently drop pending env changes", () => {
  it("bounces the container when nothing is pending", async () => {
    projectRepo.listEnvVarChangeMeta.mockResolvedValue([
      { serviceId: "svc_web", key: "API_ENDPOINT", updatedAt: BEFORE_ANCHOR },
    ]);

    const result = await restartServiceContainer(ctx, "proj_1", "svc_web");

    expect(result).toEqual({ containerId: "c_live_1" });
    expect(mockRuntime.restart).toHaveBeenCalledWith("c_live_1");
  });

  it("refuses with SERVICE_CONFIG_STALE, naming the pending keys, without touching the container", async () => {
    projectRepo.listEnvVarChangeMeta.mockResolvedValue([
      { serviceId: "svc_web", key: "API_ENDPOINT", updatedAt: AFTER_ANCHOR },
      { serviceId: "svc_web", key: "NEW_FLAG", updatedAt: AFTER_ANCHOR },
      { serviceId: "svc_web", key: "UNCHANGED", updatedAt: BEFORE_ANCHOR },
    ]);

    const err = await restartServiceContainer(ctx, "proj_1", "svc_web").catch((e) => e);

    expect(err).toBeInstanceOf(ServiceConfigStaleError);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("SERVICE_CONFIG_STALE");
    expect(err.staleEnvKeys).toEqual(["API_ENDPOINT", "NEW_FLAG"]);
    expect(err.serviceName).toBe("web");
    // Points at the path that actually applies config.
    expect(err.message).toContain("refresh");
    // The refusal is DB-only: it must not bounce the container, and must not
    // have resolved a runtime it would then abandon.
    expect(mockRuntime.restart).not.toHaveBeenCalled();
    expect(resolveDeploymentRuntimeForRead).not.toHaveBeenCalled();
  });

  it("blocks on a PROJECT-level env change, which lands on every service", async () => {
    projectRepo.listEnvVarChangeMeta.mockResolvedValue([
      { serviceId: null, key: "SHARED_SECRET", updatedAt: AFTER_ANCHOR },
    ]);

    const err = await restartServiceContainer(ctx, "proj_1", "svc_web").catch((e) => e);

    expect(err).toBeInstanceOf(ServiceConfigStaleError);
    expect(err.staleEnvKeys).toEqual(["SHARED_SECRET"]);
  });

  it("ignores another service's pending change", async () => {
    projectRepo.listEnvVarChangeMeta.mockResolvedValue([
      { serviceId: "svc_other", key: "OTHER_ONLY", updatedAt: AFTER_ANCHOR },
    ]);

    const result = await restartServiceContainer(ctx, "proj_1", "svc_web");

    expect(result).toEqual({ containerId: "c_live_1" });
    expect(mockRuntime.restart).toHaveBeenCalledWith("c_live_1");
  });

  it("force bounces despite pending changes", async () => {
    projectRepo.listEnvVarChangeMeta.mockResolvedValue([
      { serviceId: "svc_web", key: "API_ENDPOINT", updatedAt: AFTER_ANCHOR },
    ]);

    const result = await restartServiceContainer(ctx, "proj_1", "svc_web", { force: true });

    expect(result).toEqual({ containerId: "c_live_1" });
    expect(mockRuntime.restart).toHaveBeenCalledWith("c_live_1");
    // force must not even ask — the guard is skipped, not answered.
    expect(projectRepo.listEnvVarChangeMeta).not.toHaveBeenCalled();
  });

  it("clears itself once a refresh advances the active deployment past the change", async () => {
    projectRepo.listEnvVarChangeMeta.mockResolvedValue([
      { serviceId: "svc_web", key: "API_ENDPOINT", updatedAt: AFTER_ANCHOR },
    ]);
    await expect(restartServiceContainer(ctx, "proj_1", "svc_web")).rejects.toBeInstanceOf(
      ServiceConfigStaleError,
    );

    // A refresh deploy creates a new active deployment; its createdAt now
    // post-dates the env change, so the same var stops reading stale without
    // anyone recording what was applied.
    deploymentRepo.findById.mockResolvedValue({
      ...deployment,
      id: "dep_2",
      createdAt: new Date("2026-08-18T12:00:00Z"),
    });
    projectRepo.findById.mockResolvedValue({ ...project, activeDeploymentId: "dep_2" });

    const result = await restartServiceContainer(ctx, "proj_1", "svc_web");
    expect(result).toEqual({ containerId: "c_live_1" });
  });
});

describe("resolveStaleEnvKeysForService", () => {
  it("de-duplicates a key defined at both project and service scope, and sorts", async () => {
    projectRepo.listEnvVarChangeMeta.mockResolvedValue([
      { serviceId: null, key: "SHARED", updatedAt: AFTER_ANCHOR },
      { serviceId: "svc_web", key: "SHARED", updatedAt: AFTER_ANCHOR },
      { serviceId: "svc_web", key: "ALPHA", updatedAt: AFTER_ANCHOR },
    ]);

    const keys = await resolveStaleEnvKeysForService(project as never, "production", "svc_web");

    expect(keys).toEqual(["ALPHA", "SHARED"]);
  });

  it("returns nothing when the project has never deployed (no anchor to compare with)", async () => {
    projectRepo.listEnvVarChangeMeta.mockResolvedValue([
      { serviceId: "svc_web", key: "API_ENDPOINT", updatedAt: AFTER_ANCHOR },
    ]);

    const keys = await resolveStaleEnvKeysForService(
      { ...project, activeDeploymentId: null } as never,
      "production",
      "svc_web",
    );

    expect(keys).toEqual([]);
  });
});
