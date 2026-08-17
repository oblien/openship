import { beforeEach, describe, expect, it, vi } from "vitest";

const projectRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const deploymentRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serviceRepo = vi.hoisted(() => ({ listByDeployment: vi.fn() }));
const serverRepo = vi.hoisted(() => ({ get: vi.fn() }));

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

import { resolveProjectLiveState } from "./project-live-state";
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
  serverRepo.get.mockResolvedValue({ id: "srv_1", name: "contabo", sshHost: "10.0.0.8" });
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
});
