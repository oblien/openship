import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerRuntime as DockerRuntimeType } from "./docker";

const h = vi.hoisted(() => ({
  pulls: [] as Array<{ ref: string; options?: Record<string, unknown> }>,
  progressError: null as Error | null,
}));

vi.mock("dockerode", () => {
  class MissingImageDockerode {
    modem = {
      followProgress: (_stream: unknown, callback: (error: Error | null) => void) =>
        callback(h.progressError),
    };

    getImage() {
      return { inspect: async () => Promise.reject(new Error("missing")) };
    }

    async pull(ref: string, options?: Record<string, unknown>) {
      h.pulls.push({ ref, options });
      return {};
    }
  }

  return { default: MissingImageDockerode };
});

let previousDockerConfig: string | undefined;

function dockerConfig(config: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), "openship-pull-auth-"));
  writeFileSync(join(directory, "config.json"), JSON.stringify(config), { mode: 0o600 });
  return directory;
}

beforeEach(() => {
  previousDockerConfig = process.env.DOCKER_CONFIG;
  h.pulls.length = 0;
  h.progressError = null;
});

afterEach(() => {
  if (previousDockerConfig === undefined) delete process.env.DOCKER_CONFIG;
  else process.env.DOCKER_CONFIG = previousDockerConfig;
});

describe("DockerRuntime.pullImage registry authentication", () => {
  it("passes matching Docker config credentials to dockerode", async () => {
    process.env.DOCKER_CONFIG = dockerConfig({
      auths: {
        "ghcr.io": { auth: Buffer.from("pull-user:pull-secret").toString("base64") },
      },
    });
    const { DockerRuntime } = await import("./docker");
    const runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/docker.sock" });

    await runtime.pullImage("ghcr.io/example/private:immutable", { force: true });

    expect(h.pulls).toEqual([
      {
        ref: "ghcr.io/example/private:immutable",
        options: {
          authconfig: {
            username: "pull-user",
            password: "pull-secret",
            serveraddress: "ghcr.io",
          },
        },
      },
    ]);
  });

  it("rejects helper-backed credentials unavailable in the API container", async () => {
    process.env.DOCKER_CONFIG = dockerConfig({
      credHelpers: { "ghcr.io": "desktop" },
      auths: {
        "ghcr.io": { auth: Buffer.from("fallback-user:fallback-secret").toString("base64") },
      },
    });
    const { DockerRuntime } = await import("./docker");
    const runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/docker.sock" });

    await expect(
      runtime.pullImage("ghcr.io/example/private:immutable", { force: true }),
    ).rejects.toThrow("Docker credential helper is unavailable for ghcr.io; use inline auths");

    expect(h.pulls).toHaveLength(0);
  });

  it("rejects global helper stores unavailable in the API container", async () => {
    process.env.DOCKER_CONFIG = dockerConfig({ credsStore: "desktop" });
    const { DockerRuntime } = await import("./docker");
    const runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/docker.sock" });

    await expect(
      runtime.pullImage("example/private:immutable", { force: true }),
    ).rejects.toThrow("Docker credential helper is unavailable for docker.io; use inline auths");

    expect(h.pulls).toHaveLength(0);
  });

  it("does not read local Docker credentials for SSH executor pulls", async () => {
    const directory = dockerConfig({});
    writeFileSync(join(directory, "config.json"), "not-json", { mode: 0o600 });
    process.env.DOCKER_CONFIG = directory;
    const executor = { exec: vi.fn(async () => "") };
    const { DockerRuntime } = await import("./docker");
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntimeType & {
      connectionOptions: { executor: typeof executor };
    };
    Object.defineProperty(runtime, "connectionOptions", { value: { executor } });

    await runtime.pullImage("ghcr.io/example/private:immutable", { force: true });

    expect(executor.exec).toHaveBeenCalledWith(
      "docker pull 'ghcr.io/example/private:immutable'",
      { timeout: 10 * 60_000 },
    );
    expect(h.pulls).toHaveLength(0);
  });

  it("does not surface configured credential-helper details", async () => {
    const helper = "sentinel-helper-name";
    process.env.DOCKER_CONFIG = dockerConfig({ credHelpers: { "ghcr.io": helper } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { DockerRuntime } = await import("./docker");
    const runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/docker.sock" });

    let surfaced = "";
    try {
      await runtime.pullImage("ghcr.io/example/private:immutable", { force: true });
    } catch (error) {
      surfaced = error instanceof Error ? error.message : String(error);
    }

    expect(surfaced).toMatch(/credential helper is unavailable for ghcr\.io/i);
    expect(surfaced).not.toContain(helper);
    expect(h.pulls).toHaveLength(0);
    expect(JSON.stringify([...errorSpy.mock.calls, ...warnSpy.mock.calls])).not.toContain(helper);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("does not surface credential material from a Docker pull failure", async () => {
    const secret = "sentinel-registry-secret";
    process.env.DOCKER_CONFIG = dockerConfig({
      auths: { "ghcr.io": { auth: Buffer.from(`pull-user:${secret}`).toString("base64") } },
    });
    h.progressError = new Error(`registry rejected password ${secret}`);
    const { DockerRuntime } = await import("./docker");
    const runtime = await DockerRuntime.create({ dockerSocketPath: "/tmp/docker.sock" });

    let surfaced = "";
    try {
      await runtime.pullImage("ghcr.io/example/private:immutable", { force: true });
    } catch (error) {
      surfaced = error instanceof Error ? error.message : String(error);
    }

    expect(surfaced).toMatch(/failed to pull image from ghcr\.io/i);
    expect(surfaced).not.toContain(secret);
  });
});
