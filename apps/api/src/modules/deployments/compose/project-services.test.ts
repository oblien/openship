import { beforeEach, describe, expect, it, vi } from "vitest";

const { repos } = vi.hoisted(() => ({
  repos: {
    service: { listByProject: vi.fn() },
  },
}));

vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  repos,
}));

import { isMultiServiceProject, shouldUseProjectServicePipeline } from "./project-services";

describe("composePath service-pipeline bootstrap (#689)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repos.service.listByProject.mockResolvedValue([]);
  });

  it("treats an explicit composePath as service topology before rows exist", async () => {
    const project = {
      id: "project-1",
      framework: "docker",
      composePath: "deploy/stack.yml",
    } as any;

    expect(isMultiServiceProject(project)).toBe(true);
    await expect(shouldUseProjectServicePipeline(project)).resolves.toBe(true);
  });

  it("keeps an ordinary Dockerfile project on the single-app pipeline", async () => {
    const project = {
      id: "project-1",
      framework: "docker",
      composePath: null,
    } as any;

    expect(isMultiServiceProject(project)).toBe(false);
    await expect(shouldUseProjectServicePipeline(project)).resolves.toBe(false);
  });

  it("does not let retained disabled service rows hijack a single-app deploy", async () => {
    repos.service.listByProject.mockResolvedValue([
      { id: "service-disabled", kind: "compose", enabled: false },
    ]);
    const project = {
      id: "project-1",
      framework: "docker",
      composePath: null,
    } as any;

    await expect(shouldUseProjectServicePipeline(project)).resolves.toBe(false);
  });

  it("uses the service pipeline when at least one retained service is enabled", async () => {
    repos.service.listByProject.mockResolvedValue([
      { id: "service-disabled", kind: "compose", enabled: false },
      { id: "service-enabled", kind: "monorepo", enabled: true },
    ]);
    const project = {
      id: "project-1",
      framework: "docker",
      composePath: null,
    } as any;

    await expect(shouldUseProjectServicePipeline(project)).resolves.toBe(true);
  });
});
