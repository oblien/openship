import { describe, expect, it, vi } from "vitest";

import type { ImageArtifactConfig } from "../types";
import { DockerRuntime } from "./docker";
import { BuildLogger } from "./build-pipeline";

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
  const inspectImage = vi.fn(async () => ({ Id: `sha256:${"a".repeat(64)}`,
    RepoDigests: [`ghcr.io/example/app@sha256:${"b".repeat(64)}`] }));
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
    _docker: { listContainers: vi.fn(async () => []), getImage: () => ({ inspect: inspectImage }) },
    pullImage,
    removeImage,
    ...overrides,
  });

  return { runtime, pullImage, inspectImage, removeImage };
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
    const { runtime, pullImage, inspectImage } = runtimeWith();
    const logger = new BuildLogger();

    const result = await runtime.prepareImage(config({ forcePull: true }), logger);

    expect(pullImage).toHaveBeenCalledWith("ghcr.io/example/app:latest", {
      force: true, signal: expect.any(AbortSignal), logger,
    });
    expect(inspectImage).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "deploying",
      imageRef: `ghcr.io/example/app@sha256:${"b".repeat(64)}`,
      artifactOwned: false,
    });
  });

  it("freezes a local image to its image ID without requiring a registry", async () => {
    const { runtime, pullImage } = runtimeWith();

    await expect(
      runtime.prepareImage(config({ imageRef: "local-app:dev", refreshMutableTag: true })),
    ).resolves.toMatchObject({
      status: "deploying",
      imageRef: `sha256:${"a".repeat(64)}`,
      artifactOwned: false,
    });
    expect(pullImage).not.toHaveBeenCalled();
  });

  it("never removes a foreign image when acquisition fails", async () => {
    const { runtime, removeImage } = runtimeWith({
      pullImage: vi.fn(async () => {
        throw new Error("registry denied the pull");
      }),
    });

    const result = await runtime.prepareImage(config({ forcePull: true }));

    expect(result).toMatchObject({
      status: "failed",
      artifactOwned: false,
      errorMessage: expect.stringContaining("registry denied the pull"),
    });
    expect(removeImage).not.toHaveBeenCalled();
  });
});
