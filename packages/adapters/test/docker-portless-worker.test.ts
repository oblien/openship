import { describe, expect, it } from "vitest";
import { DockerRuntime } from "../src/runtime/docker";
import type { DeployConfig } from "../src/types";

/**
 * A WORKER (issue #538-B) is a long-running container that listens on no port:
 * a queue consumer, a cron, a bot. When `config.portless` is set the runtime must
 * publish NO host port, expose NO container port and inject NO `PORT` env — a
 * bound port would be a dead listener and (worse) could land a background process
 * on the public network. A web app (portless unset) keeps all three.
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
    runtimeName: "my-worker",
    slug: "my-worker",
    ...config,
  } as DeployConfig);

  return created;
}

describe("DockerRuntime.deploy — portless worker", () => {
  it("publishes no port and injects no PORT env when portless", async () => {
    const created = await captureCreate({ portless: true });
    expect(created.ExposedPorts).toBeUndefined();
    expect(created.HostConfig.PortBindings).toBeUndefined();
    expect((created.Env ?? []).some((e: string) => e.startsWith("PORT="))).toBe(false);
  });

  it("a web app (portless unset) still exposes and binds its port and gets PORT", async () => {
    const created = await captureCreate({ port: 8000 });
    expect(created.ExposedPorts).toEqual({ "8000/tcp": {} });
    expect(created.HostConfig.PortBindings["8000/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "" },
    ]);
    expect(created.Env).toContain("PORT=8000");
  });
});
