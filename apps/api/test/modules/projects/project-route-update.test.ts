import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const projectRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
}));

const serviceRepo = vi.hoisted(() => ({
  listByProject: vi.fn(),
}));

const routeState = vi.hoisted(() => ({
  listProjectRouteRows: vi.fn(),
  reapplyProjectLiveRoutes: vi.fn(),
  resolveProjectRouteState: vi.fn(),
  syncProjectRouteState: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: projectRepo,
      service: serviceRepo,
    },
  };
});

vi.mock("../../../src/modules/domains/project-route.service", () => ({
  deriveEnvironmentPublicEndpoints: vi.fn(),
  deriveNextProjectRouteState: vi.fn(),
  listProjectRouteRows: routeState.listProjectRouteRows,
  persistProjectRouteState: vi.fn(),
  reapplyProjectLiveRoutes: routeState.reapplyProjectLiveRoutes,
  resolveProjectRouteState: routeState.resolveProjectRouteState,
  syncProjectRouteState: routeState.syncProjectRouteState,
}));

vi.mock("../../../src/modules/domains/routing-apply.service", () => ({
  applyProjectRouting: vi.fn(),
}));

import { updateProject } from "../../../src/modules/projects/project-crud.service";

const project = {
  id: "proj_123",
  organizationId: "org_123",
  groupId: null,
  slug: "portfolio",
  name: "Portfolio",
  port: 4321,
  activeDeploymentId: "dep_123",
  cloudWorkspaceId: null,
  resources: null,
  buildResources: null,
  sleepMode: "auto_sleep",
};

describe("updateProject route persistence", () => {
  beforeEach(() => {
    projectRepo.findById.mockReset();
    projectRepo.update.mockReset();
    serviceRepo.listByProject.mockReset().mockResolvedValue([]);
    routeState.listProjectRouteRows.mockReset();
    routeState.reapplyProjectLiveRoutes.mockReset();
    routeState.resolveProjectRouteState.mockReset();
    routeState.syncProjectRouteState.mockReset();

    projectRepo.findById.mockResolvedValue(project);
    routeState.listProjectRouteRows.mockResolvedValue([{ hostname: "old.example.com" }]);
    // The re-apply is fire-and-forget (`.catch(...)` on the returned promise), so a
    // bare mockReset would make any test that reaches it fail on `undefined.catch`.
    routeState.reapplyProjectLiveRoutes.mockResolvedValue(undefined);
    routeState.resolveProjectRouteState.mockResolvedValue({
      projectDomains: [{ hostname: "old.example.com" }],
    });
    routeState.syncProjectRouteState.mockResolvedValue(undefined);
  });

  it("does not hold the response open for best-effort live route re-apply", async () => {
    routeState.reapplyProjectLiveRoutes.mockReturnValue(new Promise(() => {}));

    const result = await Promise.race([
      updateProject(
        project.id,
        {
          publicEndpoints: [
            {
              customDomain: "new.example.com",
              domainType: "custom",
              port: 4321,
            },
          ],
        },
        project.organizationId,
      ),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    expect(result).not.toBe("timed-out");
    expect(routeState.syncProjectRouteState).toHaveBeenCalled();
    // `managedEdgeSyncedByCaller` is asserted, not loosened away: updateProject runs
    // its own `syncProjectManagedEdge` afterwards, and letting the re-apply sync the
    // same free domain too raced it — two challenges for one target, the second
    // resetting the first's token mid-check.
    expect(routeState.reapplyProjectLiveRoutes).toHaveBeenCalledWith(project, ["old.example.com"], {
      managedEdgeSyncedByCaller: true,
    });
  });

  /**
   * #342: PATCH /projects/:id used to store any non-empty customDomain verbatim.
   * `localhost` then reached the edge as `server_name localhost;` on the next route
   * apply; the other shapes left a dead domain row and a deploy warning. The refusal
   * has to land BEFORE the field patch — the route sync runs after it, so validating
   * only there would 400 a request that had already written the rest of the body.
   */
  for (const customDomain of [
    "localhost",
    "127.0.0.1",
    "single",
    "https://example.com/app",
    "example.com/../../etc/passwd",
    "example.com:8080",
    "a b.com",
  ]) {
    it(`refuses ${JSON.stringify(customDomain)} without writing anything`, async () => {
      await expect(
        updateProject(
          project.id,
          { publicEndpoints: [{ customDomain, domainType: "custom", port: 4321 }] },
          project.organizationId,
        ),
      ).rejects.toThrow(/is not a valid custom domain/);

      expect(projectRepo.update).not.toHaveBeenCalled();
      expect(routeState.syncProjectRouteState).not.toHaveBeenCalled();
      expect(routeState.reapplyProjectLiveRoutes).not.toHaveBeenCalled();
    });
  }

  /**
   * The other half of the gate: a project that ALREADY carries a bad hostname must
   * stay editable. The submitted list is authoritative, so every save echoes the
   * whole set back — a project created before the gate (or one whose `localhost`
   * vhost a server migration adopted) would otherwise be frozen, unable even to
   * save the edit that drops it.
   */
  it("still accepts a bad hostname the project already has", async () => {
    routeState.listProjectRouteRows.mockResolvedValue([
      { hostname: "localhost" },
      { hostname: "app.example.com" },
    ]);

    await updateProject(
      project.id,
      {
        publicEndpoints: [
          { customDomain: "localhost", domainType: "custom", port: 4321 },
          { customDomain: "app.example.com", domainType: "custom", port: 4321 },
        ],
      },
      project.organizationId,
    );

    expect(routeState.syncProjectRouteState).toHaveBeenCalled();
  });

  it("refuses a NEW bad hostname even on a project that already has one", async () => {
    routeState.listProjectRouteRows.mockResolvedValue([{ hostname: "localhost" }]);

    await expect(
      updateProject(
        project.id,
        { publicEndpoints: [{ customDomain: "127.0.0.1", domainType: "custom", port: 4321 }] },
        project.organizationId,
      ),
    ).rejects.toThrow(/"127.0.0.1" is not a valid custom domain/);

    expect(projectRepo.update).not.toHaveBeenCalled();
  });

  // The scheme-stripping normalizer runs BEFORE the shape check, so a pasted URL is
  // accepted and stored bare — the same input POST /domains and the service routing
  // patch have always accepted.
  it("accepts a pasted https:// hostname", async () => {
    await updateProject(
      project.id,
      { publicEndpoints: [{ customDomain: "https://app.example.com/", domainType: "custom", port: 4321 }] },
      project.organizationId,
    );

    expect(routeState.syncProjectRouteState).toHaveBeenCalled();
  });

  /**
   * #424: internalAlias is the single-app east-west hostname. It must not shadow a
   * sidecar service's name or custom alias on the same project network — the same
   * first-match embedded-DNS collision the service-alias gate guards against.
   */
  describe("internalAlias collision", () => {
    it("refuses an internalAlias that collides with a sidecar service name", async () => {
      serviceRepo.listByProject.mockResolvedValue([{ id: "svc_1", name: "cache" }]);

      await expect(
        updateProject(project.id, { internalAlias: "cache" }, project.organizationId),
      ).rejects.toThrow(/collides/i);

      expect(projectRepo.update).not.toHaveBeenCalled();
    });

    it("refuses an internalAlias that collides with a sidecar's custom alias", async () => {
      serviceRepo.listByProject.mockResolvedValue([
        { id: "svc_1", name: "redis", advanced: { alias: "cache" } },
      ]);

      await expect(
        updateProject(project.id, { internalAlias: "cache" }, project.organizationId),
      ).rejects.toThrow(/collides/i);

      expect(projectRepo.update).not.toHaveBeenCalled();
    });

    it("allows re-saving the CURRENT internalAlias even if a sibling shares it", async () => {
      // Self-exclusion: a value that already coexists must stay editable, so a
      // no-op re-save never trips the gate (mirrors the service-alias self-edit).
      projectRepo.findById.mockResolvedValue({ ...project, internalAlias: "edge" });
      serviceRepo.listByProject.mockResolvedValue([{ id: "svc_1", name: "edge" }]);

      await updateProject(project.id, { internalAlias: "edge" }, project.organizationId);

      expect(projectRepo.update).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ internalAlias: "edge" }),
      );
    });

    it("persists a non-colliding internalAlias", async () => {
      serviceRepo.listByProject.mockResolvedValue([{ id: "svc_1", name: "redis" }]);

      await updateProject(project.id, { internalAlias: "gateway" }, project.organizationId);

      expect(projectRepo.update).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ internalAlias: "gateway" }),
      );
    });
  });
});
