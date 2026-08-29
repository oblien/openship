import { describe, expect, it, vi } from "vitest";

import type { ImageArtifactConfig } from "../types";
import { DockerRuntime } from "./docker";

const config = (overrides: Partial<ImageArtifactConfig> = {}): ImageArtifactConfig => ({
  sessionId: "prebuilt-session",
  projectId: "project-1",
  slug: "example",
  imageRef: "ghcr.io/example/app:latest",
  envVars: {},
  resources: { cpuCores: 1, memoryMb: 512, diskMb: 1024 },
  ...overrides,
});

function runtimeWith(overrides: Record<string, unknown> = {}) {
  const pullImage = vi.fn(async () => {});
  const resolveImageDigest = vi.fn(async () => "ghcr.io/example/app@sha256:abc123");
  const removeImage = vi.fn(async () => {});
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime & Record<string, unknown>;

  Object.assign(runtime, {
    connectionOptions: {},
    transport: {
      kind: "socket",
      description: "test socket",
      unreachableHint: "test daemon is unavailable",
    },
    systemManager: null,
    _docker: { listContainers: vi.fn(async () => []) },
    pullImage,
    resolveImageDigest,
    removeImage,
    ...overrides,
  });

  return { runtime, pullImage, resolveImageDigest, removeImage };
}

describe("DockerRuntime.prepareImage", () => {
  it("advertises the prebuilt-image capability used by the orchestrator gate", async () => {
    const runtime = await DockerRuntime.create({
      transport: "socket",
      dockerSocketPath: "/tmp/openship-prebuilt-capability-test.sock",
    });
    expect(runtime.supports("prebuiltImage")).toBe(true);
    await runtime.dispose();
  });

  it("pulls the application image and freezes the deploy artifact to its digest", async () => {
    const { runtime, pullImage, resolveImageDigest } = runtimeWith();

    const result = await runtime.prepareImage(config({ forcePull: true }));

    expect(pullImage).toHaveBeenCalledWith("ghcr.io/example/app:latest", { force: true });
    expect(resolveImageDigest).toHaveBeenCalledWith("ghcr.io/example/app:latest");
    expect(result).toMatchObject({
      status: "deploying",
      imageRef: "ghcr.io/example/app@sha256:abc123",
      artifactOwned: false,
    });
  });

  it("keeps the requested ref when the registry exposes no immutable digest", async () => {
    const { runtime } = runtimeWith({ resolveImageDigest: vi.fn(async () => undefined) });

    await expect(
      runtime.prepareImage(config({ imageRef: "local-app:dev" })),
    ).resolves.toMatchObject({
      status: "deploying",
      imageRef: "local-app:dev",
      artifactOwned: false,
    });
  });

  it("never removes a foreign image when acquisition fails", async () => {
    const { runtime, removeImage } = runtimeWith({
      pullImage: vi.fn(async () => {
        throw new Error("registry denied the pull");
      }),
    });

    const result = await runtime.prepareImage(config());

    expect(result).toMatchObject({
      status: "failed",
      artifactOwned: false,
      errorMessage: expect.stringContaining("registry denied the pull"),
    });
    expect(removeImage).not.toHaveBeenCalled();
  });
});
