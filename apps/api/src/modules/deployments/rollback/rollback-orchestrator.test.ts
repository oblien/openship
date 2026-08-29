import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

vi.mock("@repo/db", () => ({
  repos: {
    deployment: {
      findById: async (id: string) =>
        id === h.target?.id ? h.target : id === h.active?.id ? h.active : null,
    },
    project: { findById: async () => h.project },
    service: { listByDeployment: async () => [] },
    serviceDeployment: { effectiveImagesAsOf: async () => new Map() },
    member: { listByOrganization: async () => [{ userId: "org-owner" }] },
  },
}));

vi.mock("@repo/adapters", () => {
  class DockerRuntime {
    name = "docker";

    supports(): boolean {
      return false;
    }

    async imageExistsLocally(ref: string): Promise<boolean> {
      h.inspectedImages.push(ref);
      return h.imagePresent;
    }

    async dispose(): Promise<void> {}
  }

  return { DockerRuntime };
});

vi.mock("../../../lib/deployment-runtime", async () => {
  const { DockerRuntime } = await import("@repo/adapters");
  return {
    // The production class intentionally has a private constructor; the mock
    // factory supplies a public test double at runtime, so instantiate it from
    // its prototype without weakening the production constructor contract.
    resolveDeploymentRuntime: async () => ({ runtime: Object.create(DockerRuntime.prototype) }),
  };
});

vi.mock("../build.service", () => ({
  checkNoActiveBuild: vi.fn(),
  triggerDeployment: h.triggerDeployment,
}));

import { rollback } from "./rollback-orchestrator";

beforeEach(() => {
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

describe("rollback — reacquire a frozen release image", () => {
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
