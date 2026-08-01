import { describe, expect, it } from "vitest";
import { DockerRuntime } from "../src/runtime/docker";
import type { DeployConfig } from "../src/types";

/**
 * A single-app deploy creates a NEW container from a NEW image every time, so
 * anything the app wrote to its own filesystem is gone on redeploy unless it sits
 * on a volume. Compose services had this from the start; the app path did not, and
 * the failure is silent — the app boots on an empty directory and reports healthy.
 *
 * Named volumes must also be project-scoped, or two projects that both declare
 * `storage` share one daemon-level volume and quietly corrupt each other.
 */
async function captureCreate(config: Partial<DeployConfig>) {
  const runtime = await DockerRuntime.create();
  let created: any = null;
  runtime.docker.createContainer = (async (opts: any) => {
    created = opts;
    return { id: "c".repeat(64), start: async () => {} };
  }) as any;

  await runtime.deploy({
    deploymentId: "dep_1",
    projectId: "proj_1",
    buildSessionId: "sess_1",
    imageRef: "openship/app:sess_1",
    environment: "production",
    port: 8000,
    envVars: {},
    resources: { cpuCores: 1, memoryMb: 512 },
    runtimeName: "my-app",
    slug: "my-app",
    ...config,
  } as DeployConfig);

  return created;
}

describe("DockerRuntime.deploy persistent storage", () => {
  it("mounts declared volumes, project-scoped so two projects can't collide", async () => {
    const created = await captureCreate({ volumes: ["storage:/app/storage"] });
    expect(created.HostConfig.Binds).toEqual(["openship-my-app-storage:/app/storage"]);
  });

  it("leaves Binds unset when nothing is declared (no empty-array noise)", async () => {
    const created = await captureCreate({ volumes: [] });
    expect(created.HostConfig.Binds).toBeUndefined();
  });

  it("tolerates a snapshot from before volumes existed", async () => {
    const created = await captureCreate({});
    expect(created.HostConfig.Binds).toBeUndefined();
  });

  it("passes a host bind mount through unscoped", async () => {
    const created = await captureCreate({ volumes: ["/srv/uploads:/app/storage"] });
    expect(created.HostConfig.Binds).toEqual(["/srv/uploads:/app/storage"]);
  });

  it("falls back to runtimeName for the scope when slug is absent", async () => {
    const created = await captureCreate({ slug: undefined, volumes: ["storage:/app/storage"] });
    expect(created.HostConfig.Binds).toEqual(["openship-my-app-storage:/app/storage"]);
  });
});
