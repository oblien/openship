import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";

const h = vi.hoisted(() => ({
  project: {
    findById: vi.fn(),
    listByOrganization: vi.fn(),
    listByGroup: vi.fn(),
    findBySlugInOrg: vi.fn(),
    create: vi.fn(),
  },
  projectGroup: { findById: vi.fn() },
  deployment: { findLatestByProject: vi.fn() },
  domain: { getPrimaryByProject: vi.fn() },
}));
vi.mock("@repo/db", () => ({ repos: h, db: {}, schema: {}, getDriver: () => "postgres" }));
vi.mock("@repo/platform/engine/modules/domains/project-route.service", () => ({
  deriveNextProjectRouteState: vi.fn(),
  deriveEnvironmentPublicEndpoints: vi.fn(),
  persistProjectRouteState: vi.fn(),
  reapplyProjectLiveRoutes: vi.fn(),
  resolveProjectRouteState: vi.fn(),
  syncProjectRouteState: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/domains/routing-apply.service", () => ({
  applyProjectRouting: vi.fn(),
}));

import {
  listProjects,
  listProjectEnvironments,
  createProjectEnvironment,
} from "@repo/platform/engine/modules/projects/project-crud.service";

const project = (id: string, environmentSlug = "production", groupId = "group") => ({
  id,
  name: id,
  slug: id,
  organizationId: "org",
  groupId,
  environmentSlug,
  environmentName: environmentSlug,
  environmentType: environmentSlug === "production" ? "production" : "development",
  gitProvider: "upload",
  gitBranch: "main",
  isApp: false,
  createdAt: new Date("2026-09-11"),
});

beforeEach(() => {
  vi.resetAllMocks();
  h.project.findById.mockResolvedValue(project("production"));
  h.project.listByGroup.mockResolvedValue([project("production"), project("preview", "preview")]);
  h.projectGroup.findById.mockResolvedValue({ id: "group", name: "Example", slug: "example" });
  h.project.create.mockImplementation(async (data) => ({ ...data, id: "created-preview" }));
});

describe("project environment access", () => {
  it("selects an accessible preview before calculating grouped project totals and pages", async () => {
    h.project.listByOrganization.mockResolvedValue({
      rows: [
        project("production"),
        project("preview", "preview"),
        project("unrelated", "production", "hidden"),
      ],
      total: 3,
    });
    const result = await listProjects("org", {
      page: 1,
      perPage: 20,
      canRead: async (id) => id === "preview",
    });
    expect(result.rows.map((p) => p.id)).toEqual(["preview"]);
    expect(result.total).toBe(1);
  });

  it("does not truncate a list at 1,000 environments", async () => {
    const first = Array.from({ length: 1000 }, (_, index) =>
      project(`p${index}`, "production", `group${index}`),
    );
    h.project.listByOrganization
      .mockResolvedValueOnce({ rows: first, total: 1001 })
      .mockResolvedValueOnce({ rows: [project("last", "production", "last")], total: 1001 });
    const result = await listProjects("org", { canRead: async (id) => id === "last" });
    expect(result.rows.map((p) => p.id)).toEqual(["last"]);
    expect(result.total).toBe(1);
    expect(h.project.listByOrganization).toHaveBeenNthCalledWith(2, "org", {
      page: 2,
      perPage: 1000,
    });
  });

  it("filters sibling environments before loading their deployment and domain details", async () => {
    const result = await listProjectEnvironments(
      "production",
      "org",
      async (id) => id === "production",
    );
    expect(result.map((p) => p.id)).toEqual(["production"]);
    expect(h.deployment.findLatestByProject).toHaveBeenCalledTimes(1);
    expect(h.deployment.findLatestByProject).toHaveBeenCalledWith("production");
    expect(h.domain.getPrimaryByProject).toHaveBeenCalledTimes(1);
  });

  it("passes the creating credential into the atomic project-and-grant transaction", async () => {
    const context = {
      userId: "caller",
      organizationId: "org",
      tokenScope: { tokenId: "scoped-token" },
    } as ExecutionContext;
    const result = await createProjectEnvironment("production", context, {
      environmentName: "Staging",
      environmentSlug: "staging",
    });
    expect(result.id).toBe("created-preview");
    expect(h.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org",
        groupId: "group",
        environmentSlug: "staging",
      }),
      { tokenId: "scoped-token" },
    );
  });
});
