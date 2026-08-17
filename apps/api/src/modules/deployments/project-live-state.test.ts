import { beforeEach, describe, expect, it, vi } from "vitest";

const projectRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const deploymentRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serviceRepo = vi.hoisted(() => ({ listByDeployment: vi.fn() }));
const serverRepo = vi.hoisted(() => ({ getInOrganization: vi.fn(), get: vi.fn() }));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: projectRepo,
      deployment: deploymentRepo,
      service: serviceRepo,
      server: serverRepo,
    },
  };
});

import { resolveProjectLiveState, runtimeImageRef } from "./project-live-state";
import type { Project } from "@repo/db";

const RUNTIME_SHA = "13140747f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6";
const CODE_SHA = "b80dd90aabbccddeeff00112233445566778899a";
const BUILT_AT = new Date("2026-08-01T12:00:00.000Z");
const ACTIVATED_AT = new Date("2026-08-10T09:30:00.000Z");

const project = (over: Partial<Project> = {}) =>
  ({
    id: "proj_1",
    organizationId: "org_1",
    name: "staff",
    activeDeploymentId: "dep_runtime",
    activeReleaseDeploymentId: null,
    mountedRelease: null,
    serverId: "srv_1",
    cloudWorkspaceId: null,
    ...over,
  }) as Project;

beforeEach(() => {
  for (const fn of Object.values({ ...projectRepo, ...deploymentRepo, ...serviceRepo, ...serverRepo })) {
    fn.mockReset();
  }
  projectRepo.findById.mockResolvedValue(project());
  deploymentRepo.findById.mockImplementation(async (id: string) => {
    if (id === "dep_runtime") {
      return {
        id,
        commitSha: RUNTIME_SHA,
        imageRef: "ghcr.io/acme/staff:runtime@sha256:abc123",
        createdAt: BUILT_AT,
        updatedAt: BUILT_AT,
      };
    }
    if (id === "dep_code") {
      return {
        id,
        commitSha: CODE_SHA,
        imageRef: "/var/lib/openship/mounted-releases/proj_1/releases/dep_code",
        createdAt: ACTIVATED_AT,
        updatedAt: ACTIVATED_AT,
      };
    }
    return null;
  });
  serviceRepo.listByDeployment.mockResolvedValue([
    {
      serviceId: "svc_1",
      imageRef: "ghcr.io/acme/staff:runtime",
      imageDigest: "sha256:deadbeef",
    },
  ]);
  serverRepo.getInOrganization.mockResolvedValue({
    id: "srv_1",
    name: "contabo",
    sshHost: "10.0.0.8",
  });
});

describe("resolveProjectLiveState", () => {
  it("returns the runtime pointer and no code lane for runtime-only projects", async () => {
    const state = await resolveProjectLiveState("proj_1", "org_1");

    expect(state.runtime).toMatchObject({
      deploymentId: "dep_runtime",
      imageRef: "ghcr.io/acme/staff:runtime@sha256:abc123",
      digest: "sha256:deadbeef",
      commitSha: RUNTIME_SHA,
      builtAt: BUILT_AT.toISOString(),
    });
    expect(state.code).toBeNull();
    expect(state.server).toEqual({ id: "srv_1", name: "contabo" });
    expect(deploymentRepo.findById).toHaveBeenCalledWith("dep_runtime");
    expect(deploymentRepo.findById).not.toHaveBeenCalledWith("dep_code");
  });

  it("keeps runtime and code pointers independent after a mounted release", async () => {
    projectRepo.findById.mockResolvedValue(
      project({
        activeReleaseDeploymentId: "dep_code",
        mountedRelease: { enabled: true, containerPath: "/app", buildMode: "prebuilt" },
      }),
    );

    const state = await resolveProjectLiveState("proj_1", "org_1");

    expect(state.runtime).toMatchObject({
      deploymentId: "dep_runtime",
      commitSha: RUNTIME_SHA,
      digest: "sha256:deadbeef",
    });
    expect(state.code).toEqual({
      deploymentId: "dep_code",
      sha: CODE_SHA,
      strategy: "prebuilt",
      activatedAt: ACTIVATED_AT.toISOString(),
    });
    expect(state.runtime.imageRef).not.toMatch(/mounted-releases/);
    expect(state.public).toEqual({ hostname: null, https: "unchecked" });
  });

  it("derives server-build strategy from a prepare command when buildMode is omitted", async () => {
    projectRepo.findById.mockResolvedValue(
      project({
        activeReleaseDeploymentId: "dep_code",
        mountedRelease: {
          enabled: true,
          containerPath: "/app",
          prepareCommand: "composer install",
        },
      }),
    );

    const state = await resolveProjectLiveState("proj_1", "org_1");

    expect(state.code?.strategy).toBe("server");
  });

  it("does not invent a code pointer when mounted releases are enabled but unused", async () => {
    projectRepo.findById.mockResolvedValue(
      project({
        activeReleaseDeploymentId: null,
        mountedRelease: { enabled: true, containerPath: "/app" },
      }),
    );

    const state = await resolveProjectLiveState("proj_1", "org_1");

    expect(state.code).toEqual({
      deploymentId: null,
      sha: null,
      strategy: "prebuilt",
      activatedAt: null,
    });
    expect(state.runtime.deploymentId).toBe("dep_runtime");
  });

  it("never emits a host-path imageRef", async () => {
    deploymentRepo.findById.mockImplementation(async (id: string) =>
      id === "dep_runtime"
        ? {
            id,
            commitSha: RUNTIME_SHA,
            imageRef: "/var/lib/openship/mounted-releases/proj_1/current",
            createdAt: BUILT_AT,
            updatedAt: BUILT_AT,
          }
        : null,
    );
    serviceRepo.listByDeployment.mockResolvedValue([
      { serviceId: "svc_1", imageRef: "/var/lib/openship/mounted-releases/proj_1/current" },
    ]);

    const state = await resolveProjectLiveState("proj_1", "org_1");

    expect(state.runtime.imageRef).toBeNull();
  });

  it("prefers a service registry ref over a host-path deployment imageRef", async () => {
    deploymentRepo.findById.mockImplementation(async (id: string) =>
      id === "dep_runtime"
        ? {
            id,
            commitSha: RUNTIME_SHA,
            imageRef: "/var/lib/openship/mounted-releases/proj_1/current",
            createdAt: BUILT_AT,
            updatedAt: BUILT_AT,
          }
        : null,
    );

    const state = await resolveProjectLiveState("proj_1", "org_1");

    expect(state.runtime.imageRef).toBe("ghcr.io/acme/staff:runtime");
  });

  it("resolves the server through the org-scoped project read rule", async () => {
    await resolveProjectLiveState("proj_1", "org_1");

    expect(serverRepo.getInOrganization).toHaveBeenCalledWith("srv_1", "org_1");
    expect(serverRepo.get).not.toHaveBeenCalled();
  });

  it("uses the live-release meta serverId, not a leftover column", async () => {
    deploymentRepo.findById.mockImplementation(async (id: string) =>
      id === "dep_runtime"
        ? {
            id,
            commitSha: RUNTIME_SHA,
            imageRef: "ghcr.io/acme/staff:runtime",
            meta: { serverId: "srv_meta" },
            createdAt: BUILT_AT,
            updatedAt: BUILT_AT,
          }
        : null,
    );
    serverRepo.getInOrganization.mockResolvedValue({ id: "srv_meta", name: "Meta Box" });
    projectRepo.findById.mockResolvedValue(project({ serverId: "srv_col" }));

    const state = await resolveProjectLiveState("proj_1", "org_1");

    expect(serverRepo.getInOrganization).toHaveBeenCalledWith("srv_meta", "org_1");
    expect(state.server).toEqual({ id: "srv_meta", name: "Meta Box" });
  });

  it("omits server when the derived deploy target is not server", async () => {
    projectRepo.findById.mockResolvedValue(
      project({ cloudWorkspaceId: "ws_1", serverId: "srv_1" }),
    );

    const state = await resolveProjectLiveState("proj_1", "org_1");

    expect(state.server).toBeNull();
    expect(serverRepo.getInOrganization).not.toHaveBeenCalled();
  });
});

describe("runtimeImageRef", () => {
  it("drops every host path, including the service fallback", () => {
    expect(
      runtimeImageRef(
        "/var/lib/openship/mounted-releases/proj_1/current",
        "/var/lib/openship/mounted-releases/proj_1/releases/dep_code",
      ),
    ).toBeNull();
    expect(runtimeImageRef("/host/path", "ghcr.io/acme/app:1")).toBe("ghcr.io/acme/app:1");
  });
});
