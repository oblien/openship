import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const projectRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
}));

const routeState = vi.hoisted(() => ({
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
    },
  };
});

vi.mock("../../../src/modules/domains/project-route.service", () => ({
  deriveEnvironmentPublicEndpoints: vi.fn(),
  deriveNextProjectRouteState: vi.fn(),
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
    routeState.reapplyProjectLiveRoutes.mockReset();
    routeState.resolveProjectRouteState.mockReset();
    routeState.syncProjectRouteState.mockReset();

    projectRepo.findById.mockResolvedValue(project);
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
    expect(routeState.reapplyProjectLiveRoutes).toHaveBeenCalledWith(project, ["old.example.com"]);
  });
});
