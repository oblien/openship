import { describe, expect, it, vi } from "vitest";

import type { DeployConfig, ImageArtifactConfig } from "../types";
import { CloudRuntime } from "./cloud";

function fakeCloud() {
  const createWorkspace = vi.fn(async () => ({ id: "ws-prebuilt" }));
  const makeTemporary = vi.fn(async () => {});
  const makePermanent = vi.fn(async () => {});
  const updateResources = vi.fn(async () => {});
  const createWorkload = vi.fn(async () => {});
  const deleteWorkload = vi.fn(async () => {});
  const deleteWorkspace = vi.fn(async () => {});
  const runtime = vi.fn(async () => ({}));

  const workspace = {
    lifecycle: { makeTemporary, makePermanent },
    resources: { update: updateResources },
    workloads: { create: createWorkload, delete: deleteWorkload },
    runtime,
    delete: deleteWorkspace,
  };
  const client = {
    workspaces: { create: createWorkspace },
    workspace: vi.fn(() => workspace),
  };

  return {
    client,
    createWorkspace,
    makeTemporary,
    makePermanent,
    updateResources,
    createWorkload,
    deleteWorkload,
    deleteWorkspace,
    runtime,
  };
}

const resources = { cpuCores: 1, memoryMb: 768, diskMb: 2048 };

const imageConfig = (overrides: Partial<ImageArtifactConfig> = {}): ImageArtifactConfig => ({
  sessionId: "image-session",
  projectId: "project-1",
  slug: "example",
  imageRef: "ghcr.io/example/app:1.2.3",
  envVars: { APP_ENV: "production" },
  resources,
  ...overrides,
});

const deployConfig = (overrides: Partial<DeployConfig> = {}): DeployConfig => ({
  deploymentId: "deployment-1",
  projectId: "project-1",
  buildSessionId: "image-session",
  imageRef: "ws-prebuilt",
  prebuiltImage: true,
  environment: "production",
  port: 8080,
  envVars: { APP_ENV: "production" },
  resources,
  ...overrides,
});

describe("CloudRuntime prebuilt images", () => {
  it("creates an owned temporary workspace directly from the application image", async () => {
    const cloud = fakeCloud();
    const runtime = new CloudRuntime(cloud.client as never);

    expect(runtime.supports("prebuiltImage")).toBe(true);
    const result = await runtime.prepareImage(imageConfig());

    expect(cloud.createWorkspace).toHaveBeenCalledWith({
      name: "example",
      image: "ghcr.io/example/app:1.2.3",
      mode: "temporary",
      config: {
        cpus: 1,
        memory_mb: 768,
        disk_size_mb: 2048,
        env: ["APP_ENV=production"],
      },
    });
    expect(cloud.makeTemporary).toHaveBeenCalledWith({
      ttl: "15m",
      ttl_action: "remove",
      remove_on_exit: true,
    });
    expect(result).toMatchObject({
      status: "deploying",
      imageRef: "ws-prebuilt",
      artifactOwned: true,
    });
  });

  it("returns the owned workspace for idempotent cleanup when cancelled during provisioning", async () => {
    const cloud = fakeCloud();
    let finishRuntime!: () => void;
    const runtimeBlocked = new Promise<void>((resolve) => {
      finishRuntime = resolve;
    });
    let enteredRuntime!: () => void;
    const runtimeEntered = new Promise<void>((resolve) => {
      enteredRuntime = resolve;
    });
    cloud.runtime.mockImplementationOnce(async () => {
      enteredRuntime();
      await runtimeBlocked;
      return {};
    });
    const runtime = new CloudRuntime(cloud.client as never);

    const resultPromise = runtime.prepareImage(imageConfig({ sessionId: "cancel-image" }));
    await runtimeEntered;
    await runtime.cancelBuild("cancel-image");
    finishRuntime();

    await expect(resultPromise).resolves.toMatchObject({
      status: "cancelled",
      imageRef: "ws-prebuilt",
      artifactOwned: true,
    });
    expect(cloud.deleteWorkspace).toHaveBeenCalled();
    expect(cloud.createWorkload).not.toHaveBeenCalled();
  });

  it("preserves the image default CMD and WORKDIR instead of creating npm start", async () => {
    const cloud = fakeCloud();
    const runtime = new CloudRuntime(cloud.client as never);
    await runtime.prepareImage(imageConfig());

    const result = await runtime.deploy(
      deployConfig({ productionPaths: ["dist", "node_modules"] }),
    );

    expect(result.status).toBe("running");
    expect(cloud.makePermanent).toHaveBeenCalledOnce();
    expect(cloud.createWorkload).not.toHaveBeenCalled();
    // prepareImage connects once; deploy must not manipulate /app to honor
    // productionPaths inherited from source-build settings.
    expect(cloud.runtime).toHaveBeenCalledOnce();
  });

  it("still honors an explicit command override for a prebuilt image", async () => {
    const cloud = fakeCloud();
    const runtime = new CloudRuntime(cloud.client as never);
    await runtime.prepareImage(imageConfig());

    await runtime.deploy(deployConfig({ startCommand: "./serve --foreground" }));

    expect(cloud.deleteWorkload).toHaveBeenCalledWith("app");
    expect(cloud.createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "app",
        cmd: ["sh", "-c", "cd '/' && ./serve --foreground"],
        working_dir: "/",
      }),
    );
  });

  it("preserves the historical npm-start fallback for source-build artifacts", async () => {
    const cloud = fakeCloud();
    const runtime = new CloudRuntime(cloud.client as never);

    await runtime.deploy(deployConfig({ prebuiltImage: false }));

    expect(cloud.createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: ["sh", "-c", "cd '/app' && npm start"],
        working_dir: "/app",
      }),
    );
  });
});
