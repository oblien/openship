import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  report: vi.fn(),
  env: { CLOUD_MODE: false },
}));
vi.mock("@repo/db", () => ({
  repos: { serviceIncident: { listOpenForActiveProjects: h.list } },
}));
vi.mock("@repo/core/diagnostics", () => ({ reportCaughtError: h.report }));
vi.mock("@repo/platform/engine/config/index", () => ({ env: h.env }));
import { loadProjectRuntimeHealth } from "@repo/platform/engine/modules/projects/project-runtime-health";

const project = {
  id: "project",
  organizationId: "org",
  activeDeploymentId: "active",
  disabledAt: null,
};
beforeEach(() => {
  h.env.CLOUD_MODE = false;
  h.list.mockReset().mockResolvedValue([]);
  h.report.mockReset();
});

describe("runtime health projection", () => {
  it("does not query for paused or undeployed projects", async () => {
    expect(
      (
        await loadProjectRuntimeHealth([
          { ...project, disabledAt: new Date() },
          { ...project, activeDeploymentId: null },
        ])
      ).size,
    ).toBe(0);
    expect(h.list).not.toHaveBeenCalled();
  });

  it("leaves Cloud continuous-monitoring behavior unchanged", async () => {
    h.env.CLOUD_MODE = true;
    expect((await loadProjectRuntimeHealth([project])).size).toBe(0);
    expect(h.list).not.toHaveBeenCalled();
  });

  it("rejects foreign, out-of-scope and resolved incident rows", async () => {
    h.list.mockResolvedValue([
      {
        id: "current",
        projectId: "project",
        organizationId: "org",
        status: "open",
      },
      {
        id: "foreign",
        projectId: "project",
        organizationId: "other",
        status: "open",
      },
      {
        id: "outside",
        projectId: "other",
        organizationId: "org",
        status: "open",
      },
      {
        id: "resolved",
        projectId: "project",
        organizationId: "org",
        status: "resolved",
      },
    ]);
    expect(
      (await loadProjectRuntimeHealth([project]))
        .get("project")
        ?.map((row) => row.id),
    ).toEqual(["current"]);
  });

  it("logs a failed lookup without breaking project reads or claiming a live probe", async () => {
    const error = new Error("database unavailable");
    h.list.mockRejectedValue(error);
    expect((await loadProjectRuntimeHealth([project])).size).toBe(0);
    expect(h.report).toHaveBeenCalledWith(error, "projects/runtime-health");
  });
});
