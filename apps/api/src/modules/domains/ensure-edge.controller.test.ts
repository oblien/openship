import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findProject: vi.fn(),
  findDeployment: vi.fn(),
  getServerInOrganization: vi.fn(),
  findLocalServer: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: {
        ...actual.repos.project,
        findById: h.findProject,
      },
      deployment: {
        ...actual.repos.deployment,
        findById: h.findDeployment,
      },
      server: {
        ...actual.repos.server,
        getInOrganization: h.getServerInOrganization,
      },
    },
  };
});

vi.mock("@repo/platform/engine/lib/startup/self-server", () => ({
  findLocalServer: () => h.findLocalServer(),
}));

import { resolveProjectServer } from "./ensure-edge.controller";

const project = {
  id: "project-1",
  organizationId: "org-1",
  cloudWorkspaceId: null,
  activeDeploymentId: "deployment-1",
  // This is the destination selected for a future deploy, not where the active
  // release and its edge currently live.
  serverId: "server-next",
};

describe("resolveProjectServer", () => {
  beforeEach(() => {
    h.findProject.mockReset().mockResolvedValue(project);
    h.findDeployment.mockReset().mockResolvedValue({
      id: "deployment-1", projectId: "project-1", organizationId: "org-1",
      meta: { serverId: "server-live" },
    });
    h.getServerInOrganization.mockReset().mockResolvedValue({ id: "server-live" });
    h.findLocalServer.mockReset().mockResolvedValue(null);
  });

  it("targets the active deployment snapshot before the mutable project binding", async () => {
    const result = await resolveProjectServer("project-1", "org-1");

    expect(result).toMatchObject({ serverId: "server-live" });
    expect(h.getServerInOrganization).toHaveBeenCalledWith("server-live", "org-1");
    expect(h.getServerInOrganization).not.toHaveBeenCalledWith("server-next", "org-1");
  });

  it("keeps targeting an active server after the project's next target changes to cloud", async () => {
    h.findProject.mockResolvedValue({
      ...project,
      cloudWorkspaceId: "workspace-next",
    });
    h.findDeployment.mockResolvedValue({
      id: "deployment-1", projectId: "project-1", organizationId: "org-1",
      meta: { deployTarget: "server", serverId: "server-live" },
    });

    await expect(resolveProjectServer("project-1", "org-1")).resolves.toMatchObject({
      serverId: "server-live",
    });
    expect(h.getServerInOrganization).toHaveBeenCalledWith("server-live", "org-1");
  });

  it("does not use an unscoped server id from historical snapshot metadata", async () => {
    h.getServerInOrganization.mockResolvedValue(null);

    await expect(resolveProjectServer("project-1", "org-1")).resolves.toEqual({
      error: "Project deployment server was not found",
      status: 400,
    });
  });

  it("uses the local server instead of a future server when the active release is explicitly local", async () => {
    h.findDeployment.mockResolvedValue({
      id: "deployment-1", projectId: "project-1", organizationId: "org-1",
      meta: { deployTarget: "local" },
    });
    h.findLocalServer.mockResolvedValue({ id: "server-local", isLocal: true });
    h.getServerInOrganization.mockResolvedValue({ id: "server-local", isLocal: true });

    await expect(resolveProjectServer("project-1", "org-1")).resolves.toMatchObject({
      serverId: "server-local",
      isLocal: true,
    });
    expect(h.getServerInOrganization).toHaveBeenCalledWith("server-local", "org-1");
    expect(h.getServerInOrganization).not.toHaveBeenCalledWith("server-next", "org-1");
  });

  it("falls back to local server when serverId is null on local projects", async () => {
    h.findProject.mockResolvedValue({
      ...project,
      serverId: null,
    });
    h.findDeployment.mockResolvedValue({
      id: "deployment-1", projectId: "project-1", organizationId: "org-1",
      meta: {},
    });
    h.findLocalServer.mockResolvedValue({ id: "server-local", isLocal: true });
    h.getServerInOrganization.mockResolvedValue({ id: "server-local", isLocal: true });

    const result = await resolveProjectServer("project-1", "org-1");

    expect(result).toMatchObject({
      serverId: "server-local",
      isLocal: true,
    });
  });

  it("does not redirect a server deployment with a missing server id to the local host", async () => {
    h.findProject.mockResolvedValue({
      ...project,
      serverId: null,
    });
    h.findDeployment.mockResolvedValue({
      id: "deployment-1", projectId: "project-1", organizationId: "org-1",
      meta: { deployTarget: "server" },
    });
    h.findLocalServer.mockResolvedValue({ id: "server-local", isLocal: true });

    await expect(resolveProjectServer("project-1", "org-1")).resolves.toEqual({
      error: "Project is not deployed to a server",
      status: 400,
    });
    expect(h.findLocalServer).not.toHaveBeenCalled();
    expect(h.getServerInOrganization).not.toHaveBeenCalled();
  });
});
