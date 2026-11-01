import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  project: { id: "project-a", organizationId: "org-a", activeDeploymentId: "deployment-a" },
  deployment: { id: "deployment-a", projectId: "project-a", organizationId: "org-a" },
  lookup: vi.fn(),
  serviceRows: vi.fn(async () => []),
}));

vi.mock("@repo/db", () => ({
  repos: {
    deployment: { findById: h.lookup },
    service: { listByDeployment: h.serviceRows },
  },
}));

const { findActiveDeployment, listActiveServiceDeployments, activeDeploymentForProject } =
  await import("@repo/platform/engine/lib/active-deployment");

beforeEach(() => {
  h.deployment = { id: "deployment-a", projectId: "project-a", organizationId: "org-a" };
  h.lookup.mockReset().mockImplementation(async () => h.deployment);
  h.serviceRows.mockClear();
});

describe("active-deployment service and batch ownership", () => {
  it.each([
    { projectId: "project-b", organizationId: "org-a" },
    { projectId: "project-a", organizationId: "org-b" },
  ])("does not query service containers from a mismatched deployment: %j", async (owner) => {
    Object.assign(h.deployment, owner);
    expect(await listActiveServiceDeployments(h.project)).toEqual([]);
    expect(h.serviceRows).not.toHaveBeenCalled();
  });

  it("queries service containers for the project's own deployment", async () => {
    expect(await listActiveServiceDeployments(h.project)).toEqual([]);
    expect(h.serviceRows).toHaveBeenCalledWith("deployment-a");
  });

  it("does not query a deployment when the project has no active pointer", async () => {
    const project = { ...h.project, activeDeploymentId: null };
    expect(await findActiveDeployment(project)).toBeUndefined();
    expect(await listActiveServiceDeployments(project)).toEqual([]);
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.serviceRows).not.toHaveBeenCalled();
  });

  it("does not adopt a sibling project's valid entry from a shared batch map", () => {
    const sibling = {
      id: "project-b",
      organizationId: "org-a",
      activeDeploymentId: "deployment-a",
    };
    const candidate = h.deployment as unknown as Parameters<typeof activeDeploymentForProject>[1];
    expect(activeDeploymentForProject(h.project, candidate)).toBe(candidate);
    expect(activeDeploymentForProject(sibling, candidate)).toBeUndefined();
  });
});
