import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FROZEN_RELEASE_IMAGE = `ghcr.io/acme/app@sha256:${"b".repeat(64)}`;

interface TriggerRequest {
  projectId: string;
  branch?: string | null;
  trigger: string;
  forceAll: boolean;
  commitSha?: string;
  commitShaBefore?: string;
  reuseSnapshot: {
    envVars: Record<string, string> | null;
    meta: Record<string, unknown>;
  };
}

const h = vi.hoisted(() => ({
  imagePresent: false,
  inspectedImages: [] as string[],
  triggerDeployment: vi.fn(),
  target: null as Record<string, unknown> | null,
  active: null as Record<string, unknown> | null,
  project: null as Record<string, unknown> | null,
  runtimeName: "docker",
  localHost: false,
  runtimeDisposed: false,
  pathExists: vi.fn(),
  serviceImages: [] as Array<{ serviceId: string; serviceName: string; imageRef: string }>,
  liveServices: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    deployment: {
      findById: async (id: string) =>
        id === h.target?.id ? h.target : id === h.active?.id ? h.active : null,
    },
    project: { findById: async () => h.project },
    service: { listByDeployment: async () => h.serviceImages, listByProject: h.liveServices },
    serviceDeployment: { effectiveImagesAsOf: async () => new Map() },
    member: { listByOrganization: async () => [{ userId: "org-owner" }] },
  },
}));

vi.mock("@repo/adapters", async (original) => {
  const actual = await original<typeof import("@repo/adapters")>();
  class DockerRuntime {
    get name() { return h.runtimeName; }

    supports(): boolean {
      return false;
    }

    async imageExistsLocally(ref: string): Promise<boolean> {
      h.inspectedImages.push(ref);
      return h.imagePresent;
    }

    async dispose(): Promise<void> { h.runtimeDisposed = true; }
  }

  return { ...actual, DockerRuntime };
});

vi.mock("@repo/platform/engine/lib/deployment-runtime", async () => {
  const { DockerRuntime } = await import("@repo/adapters");
  return {
    // The production class intentionally has a private constructor; the mock
    // factory supplies a public test double at runtime, so instantiate it from
    // its prototype without weakening the production constructor contract.
    resolveDeploymentRuntime: async () => ({
      runtime: Object.create(DockerRuntime.prototype),
      localHost: h.localHost,
      executor: { exists: h.pathExists },
    }),
    resolveServerExecutor: async () => {
      if ((h.target?.meta as { deployTarget?: string })?.deployTarget === "cloud")
        throw new Error("Managed servers require the deployment destination");
      return { executor: { exists: h.pathExists }, isLocal: h.localHost };
    },
  };
});

vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  checkNoActiveBuild: vi.fn(),
  triggerDeployment: h.triggerDeployment,
}));

import { resolveRestorePlan, rollback } from "@repo/platform/engine/modules/deployments/rollback/rollback-orchestrator";
import { snapshotNeedsGitSource, withoutPinnedArtifacts } from "@repo/platform/engine/modules/deployments/pinned-artifacts";

beforeEach(() => {
  h.runtimeName = "docker";
  h.localHost = false;
  h.runtimeDisposed = false;
  h.pathExists.mockReset();
  h.pathExists.mockResolvedValue(false);
  h.serviceImages = [];
  h.liveServices.mockReset();
  h.imagePresent = false;
  h.inspectedImages = [];
  h.triggerDeployment.mockReset();
  h.triggerDeployment.mockResolvedValue({ deployment: { id: "dep-restored" } });

  h.target = {
    id: "dep-target",
    projectId: "project-1",
    organizationId: "org-1",
    status: "ready",
    containerId: "old-container",
    imageRef: "ghcr.io/acme/app:v1.2.3",
    commitSha: null,
    commitShaBefore: null,
    commitMessage: "Release v1.2.3",
    branch: null,
    environment: "production",
    envVars: { API_KEY: "encrypted-frozen" },
    artifactRetainedAt: new Date("2026-08-01T00:00:00Z"),
    createdAt: new Date("2026-08-01T00:00:00Z"),
    meta: {
      framework: "docker",
      branch: "frozen-release-branch",
      source: "image",
      build: "prebuilt",
      workload: "web",
      serviceDeploymentMode: "single",
      releaseVersion: "1.2.3",
      releaseTag: "v1.2.3",
      releaseImageRef: FROZEN_RELEASE_IMAGE,
      // A pin from an earlier restore must not turn reacquisition into a local
      // handover. The planner proved the local image is absent.
      handoverAppImage: "ghcr.io/acme/app:stale-local-pin",
    },
  };
  h.active = {
    id: "dep-active",
    projectId: "project-1", organizationId: "org-1",
    commitSha: "newer-commit",
  };
  h.project = {
    id: "project-1",
    organizationId: "org-1",
    activeDeploymentId: "dep-active",
    defaultRollbackStrategy: "snapshot",
    gitProvider: "release",
    // Deliberately different from the frozen ref. Rollback must not render this
    // current template or resolve its current tag.
    releaseSource: {
      mode: "github",
      artifactKind: "image",
      repo: "acme/app",
      imageTemplate: "ghcr.io/acme/app:changed-{tag}",
    },
  };
});

describe("static rollback inspects the selected deployment's filesystem", () => {
  function staticTarget(path: string, deployTarget: "cloud" | "server" | "local") {
    h.target!.containerId = path;
    h.target!.imageRef = null;
    h.target!.meta = {
      workload: "static", runtimeMode: "bare", deployTarget,
      ...(deployTarget === "local" ? {} : { serverId: "server-1" }),
      staticServeOutputDir: "apps/site/out",
    };
  }

  it.each(["cloud", "server"] as const)("finds retained files through the %s executor before disposing it", async target => {
    const path = "/only-on-the-selected-server/releases/dep-target";
    staticTarget(path, target);
    h.pathExists.mockImplementation(async () => {
      expect(h.runtimeDisposed).toBe(false);
      return true;
    });
    const { plan } = await resolveRestorePlan("dep-target");
    expect(plan).toMatchObject({ mode: "redeploy-pinned", handoverStaticDir: path });
    expect(h.pathExists).toHaveBeenCalledExactlyOnceWith(path);
    expect(h.runtimeDisposed).toBe(true);
  });

  it.each([false, "unreachable"])("never substitutes local files when the server reports %s", async result => {
    const path = await mkdtemp(join(tmpdir(), "openship-remote-restore-"));
    try {
      staticTarget(path, "cloud");
      if (result === "unreachable") h.pathExists.mockRejectedValue(new Error("server unreachable"));
      const { plan } = await resolveRestorePlan("dep-target");
      expect(plan).toMatchObject({ mode: "ineligible", code: "ROLLBACK_ARTIFACT_GONE" });
      expect(h.pathExists).toHaveBeenCalledExactlyOnceWith(path);
      expect(h.runtimeDisposed).toBe(true);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("reads a local static mount without needing the host SSH channel", async () => {
    const path = await mkdtemp(join(tmpdir(), "openship-local-restore-"));
    try {
      staticTarget(path, "local");
      h.localHost = true;
      h.pathExists.mockRejectedValue(new Error("host channel disabled"));
      expect((await resolveRestorePlan("dep-target")).plan)
        .toMatchObject({ mode: "redeploy-pinned", handoverStaticDir: path });
      expect(h.pathExists).not.toHaveBeenCalled();
      expect(h.runtimeDisposed).toBe(true);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });
});

describe("rollback — reacquire a frozen release image", () => {
  it("restores a cluster digest without changing the source used by a later redeploy", async () => {
    h.runtimeName = "kubernetes";
    h.target!.imageRef = FROZEN_RELEASE_IMAGE;
    h.target!.commitSha = "abc1234";
    h.target!.meta = {
      deployTarget: "cluster", clusterId: "cluster-1", clusterRuntimeId: "runtime-1",
      clusterProjectId: "project-1", clusterConfig: { replicas: 3 },
      source: "git", repoUrl: "https://github.com/acme/app", branch: "main",
      framework: "node", serviceDeploymentMode: "single",
    };
    await rollback("dep-target");
    const [, request] = h.triggerDeployment.mock.calls[0] as [unknown, TriggerRequest];
    expect(request.commitSha).toBeUndefined();
    expect(request.reuseSnapshot.meta).toMatchObject({
      clusterId: "cluster-1", clusterRuntimeId: "runtime-1", clusterConfig: { replicas: 3 },
      source: "git", handoverAppImage: FROZEN_RELEASE_IMAGE,
    });
    expect(request.reuseSnapshot.meta.releaseImageRef).toBeUndefined();
    expect(snapshotNeedsGitSource(request.reuseSnapshot.meta)).toBe(false);
    expect(snapshotNeedsGitSource(withoutPinnedArtifacts(request.reuseSnapshot.meta))).toBe(true);
    expect(request.reuseSnapshot.envVars).toEqual({ API_KEY: "encrypted-frozen" });
  });

  it("pins Cloud Docker service images while retaining the original shared workspace and volume configuration", async () => {
    h.runtimeName = "cloud";
    h.imagePresent = true;
    h.serviceImages = [{ serviceId: "web", serviceName: "web", imageRef: "openship/app-web:bld_v1" }];
    const binding = { projectId: "project-1", workspaceId: "shared-vm" };
    const services = [{ id: "web", name: "web", volumes: ["data:/data"] }];
    h.target!.imageRef = "compose";
    h.target!.meta = { deployTarget: "cloud", runtimeMode: "docker", buildStrategy: "server",
      serviceDeploymentMode: "services", workspaceId: "shared-vm", cloudDockerWorkspace: binding, composeServices: services };
    await rollback("dep-target");
    const [, request] = h.triggerDeployment.mock.calls[0] as [unknown, TriggerRequest];
    expect(request.reuseSnapshot.meta).toMatchObject({
      cloudDockerWorkspace: binding, workspaceId: "shared-vm", composeServices: services,
      handoverImages: { web: "openship/app-web:bld_v1" }, buildStrategy: "server", deployTarget: "cloud",
    });
    expect(request.reuseSnapshot.envVars).toEqual({ API_KEY: "encrypted-frozen" });
  });
  it("replays the immutable snapshot without a commit, repository, or stale local pin", async () => {
    await rollback("dep-target");

    expect(h.inspectedImages).toEqual(["ghcr.io/acme/app:v1.2.3"]);
    expect(h.triggerDeployment).toHaveBeenCalledTimes(1);
    const [, request] = h.triggerDeployment.mock.calls[0] as [unknown, TriggerRequest];

    expect(request).toMatchObject({
      projectId: "project-1",
      branch: "frozen-release-branch",
      trigger: "rollback",
      forceAll: true,
      commitShaBefore: "newer-commit",
    });
    expect(request.commitSha).toBeUndefined();
    expect(request.reuseSnapshot.envVars).toEqual({ API_KEY: "encrypted-frozen" });
    expect(request.reuseSnapshot.meta.releaseImageRef).toBe(FROZEN_RELEASE_IMAGE);
    expect(request.reuseSnapshot.meta.releaseTag).toBe("v1.2.3");
    expect(request.reuseSnapshot.meta.handoverAppImage).toBeUndefined();
    expect(JSON.stringify(request.reuseSnapshot.meta)).not.toContain("changed-{tag}");
  });
});

describe("legacy Compose configuration integrity (#985)", () => {
  it.each([true, false])(
    "refuses damaged frozen credentials before starting a rollback (current service exists=%s)",
    async (hasLiveService) => {
      const frozen = {
        composeServices: [
          { name: "app", environment: { DATABASE_URL: "postgresql://***@db:5432/app" } },
          { name: "db", environment: { POSTGRES_PASSWORD: "release-password" } },
        ],
      };
      h.target!.meta = frozen;
      h.target!.commitSha = "a".repeat(40);
      h.target!.imageRef = "compose";
      h.serviceImages = [{ serviceId: "app", serviceName: "app", imageRef: "app:old" }];
      h.imagePresent = true;
      h.liveServices.mockResolvedValue(
        hasLiveService
          ? [
              {
                name: "app",
                kind: "compose",
                environment: {
                  DATABASE_URL:
                    "postgresql://app:current-password@different-db:5432/other-database",
                },
              },
            ]
          : [],
      );
      const { plan } = await resolveRestorePlan("dep-target");
      expect(plan).toMatchObject({ mode: "ineligible", code: "ROLLBACK_CONFIGURATION_REDACTED" });
      expect(JSON.stringify(plan)).not.toContain("release-password");
      await expect(rollback("dep-target")).rejects.toMatchObject({
        code: "ROLLBACK_CONFIGURATION_REDACTED",
      });
      expect(h.triggerDeployment).not.toHaveBeenCalled();
      expect(h.liveServices).not.toHaveBeenCalled();
      expect(h.target!.meta).toEqual(frozen);
      expect(h.project!.activeDeploymentId).toBe("dep-active");
    },
  );
});
