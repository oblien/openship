import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuildConfig, CommandExecutor } from "../types";
import { BuildLogger } from "./build-pipeline";
import {
  DEFAULT_DOCKER_BUILD_IDLE_TIMEOUT_MS,
  MAX_DOCKER_BUILD_IDLE_TIMEOUT_MS,
  MIN_DOCKER_BUILD_IDLE_TIMEOUT_MS,
  chooseDockerBuildFailureHint,
  dockerBuildExitMessage,
  dockerBuildIdleTimeoutError,
  extractDockerBuildFailureHint,
  getDockerBuildIdleTimeoutMs,
  startDockerBuildIdleMonitor,
} from "./docker-build-diagnostics";
import { DockerRuntime } from "./docker";

describe("Docker build diagnostics", () => {
  it("accepts only bounded integer inactivity timeouts", () => {
    expect(getDockerBuildIdleTimeoutMs(undefined)).toBe(DEFAULT_DOCKER_BUILD_IDLE_TIMEOUT_MS);
    expect(getDockerBuildIdleTimeoutMs("60000")).toBe(MIN_DOCKER_BUILD_IDLE_TIMEOUT_MS);
    expect(getDockerBuildIdleTimeoutMs(String(MAX_DOCKER_BUILD_IDLE_TIMEOUT_MS))).toBe(
      MAX_DOCKER_BUILD_IDLE_TIMEOUT_MS,
    );

    for (const invalid of ["", "nope", "59999", "86400001", "90000.5", "Infinity", "-1"]) {
      expect(getDockerBuildIdleTimeoutMs(invalid)).toBe(DEFAULT_DOCKER_BUILD_IDLE_TIMEOUT_MS);
    }
  });

  it.each([
    "@beacon/web build: Exited with code 0",
    "Process exited with exit code: 0",
    "process completed: exit code 0",
  ])("does not treat a successful exit as failure evidence: %s", (line) => {
    expect(extractDockerBuildFailureHint(line)).toBeNull();
  });

  it("describes exit 137 accurately without claiming that SIGKILL proves OOM", () => {
    const hint = extractDockerBuildFailureHint(
      "The command '/bin/sh -c bun run build' returned a non-zero code: 137",
      { configuredMemoryMb: 512, memoryLimitApplied: true },
    );

    expect(hint).toContain("killed by SIGKILL (exit code 137)");
    expect(hint).toContain("does not prove OOM");
    expect(hint).toContain("capped at 512 MB RAM");
  });

  it("does not claim the configured memory cap applied to SSH or BuildKit", () => {
    const hint = dockerBuildExitMessage(137, null, {
      configuredMemoryMb: 512,
      memoryLimitApplied: false,
    });

    expect(hint).toContain("not under an OpenShip-enforced memory cap");
    expect(hint).not.toContain("capped at 512 MB");
  });

  it.each([
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    "fatal error: runtime: out of memory",
    "npm ERR! code ENOMEM",
    "fork: cannot allocate memory",
  ])("recognizes explicit allocator failure: %s", (line) => {
    expect(extractDockerBuildFailureHint(line)?.toLowerCase()).toMatch(
      /ran out of memory|could not allocate memory/,
    );
  });

  it("keeps explicit memory evidence over a later wrapper error", () => {
    const memory = extractDockerBuildFailureHint("npm ERR! code ENOMEM")!;
    const wrapper = "failed to solve: process did not complete successfully: exit code: 1";
    expect(chooseDockerBuildFailureHint(memory, wrapper)).toBe(memory);
    expect(dockerBuildExitMessage(1, memory)).toBe(memory);
  });

  it("reports an inactivity timeout as a timeout, not a proven OOM", () => {
    const error = dockerBuildIdleTimeoutError(10 * 60_000, {
      configuredMemoryMb: 1024,
      memoryLimitApplied: true,
    });
    expect(error.message).toContain("no output for 10 minutes and was cancelled");
    expect(error.message).toContain("memory pressure is one possible cause");
  });
});

describe("Docker build inactivity monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-arms on real progress and reports elapsed silence", async () => {
    const onIdle = vi.fn();
    const onTimeout = vi.fn();
    const monitor = startDockerBuildIdleMonitor({
      timeoutMs: 2 * 60_000,
      onIdle,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onIdle).toHaveBeenLastCalledWith(60_000);

    await vi.advanceTimersByTimeAsync(30_000);
    monitor.progress();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("releases its deadline when stopped", async () => {
    const onTimeout = vi.fn();
    const monitor = startDockerBuildIdleMonitor({
      timeoutMs: 60_000,
      onIdle: vi.fn(),
      onTimeout,
    });
    monitor.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

function buildConfig(): BuildConfig {
  return {
    sessionId: "diagnostic-build",
    projectId: "project-1",
    slug: "diagnostic-build",
    repoUrl: "https://example.com/repo.git",
    branch: "main",
    stack: "docker",
    buildImage: "",
    packageManager: "",
    installCommand: "",
    buildCommand: "",
    outputDirectory: "",
    port: 3000,
    runtimeImage: "",
    envVars: {},
    resources: { cpuCores: 1, memoryMb: 512, diskMb: 0 },
  };
}

describe("DockerRuntime build failure paths", () => {
  const previousTimeout = process.env.OPENSHIP_BUILD_IDLE_TIMEOUT_MS;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.OPENSHIP_BUILD_IDLE_TIMEOUT_MS = String(MIN_DOCKER_BUILD_IDLE_TIMEOUT_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousTimeout === undefined) delete process.env.OPENSHIP_BUILD_IDLE_TIMEOUT_MS;
    else process.env.OPENSHIP_BUILD_IDLE_TIMEOUT_MS = previousTimeout;
  });

  it.each([null, "The command returned a non-zero code: 1"])(
    "does not let a successful Bun step override the Docker result: %s",
    async (dockerError) => {
      const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
      Object.assign(runtime, {
        _docker: {
          modem: {
            followProgress: (
              _stream: unknown,
              finished: (error: Error | null) => void,
              progress: (event: { stream?: string; error?: string }) => void,
            ) => {
              progress({ stream: "@beacon/web build: Exited with code 0\n" });
              if (dockerError) {
                progress({ error: dockerError });
              } else {
                progress({ stream: "Successfully built abc123\n" });
                progress({ stream: "Successfully tagged openship/test:build\n" });
              }
              finished(null);
            },
          },
        },
      });

      const result = (runtime as any).streamDockerodeBuild(new PassThrough(), new BuildLogger());
      if (dockerError) {
        await expect(result).rejects.toThrow(dockerError);
      } else {
        await expect(result).resolves.toBeUndefined();
      }
    },
  );

  it("times out a daemon stream without discovering or killing host containers", async () => {
    const stream = new PassThrough();
    stream.on("error", () => {});
    const listContainers = vi.fn();
    const getContainer = vi.fn();
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime &
      Record<string, unknown>;
    Object.assign(runtime, {
      _docker: {
        listContainers,
        getContainer,
        modem: { followProgress: vi.fn() },
      },
    });
    const abortBuild = vi.fn();

    const result = (runtime as any)
      .streamDockerodeBuild(stream, new BuildLogger(), {
        diagnosticContext: {
          configuredMemoryMb: 512,
          memoryLimitApplied: true,
        },
        abortBuild,
      })
      .catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(MIN_DOCKER_BUILD_IDLE_TIMEOUT_MS);

    await expect(result).resolves.toMatchObject({
      message: expect.stringContaining("no output for 1 minute and was cancelled"),
    });
    expect(abortBuild).toHaveBeenCalledOnce();
    expect(abortBuild).toHaveBeenCalledWith(expect.any(Error));
    expect(listContainers).not.toHaveBeenCalled();
    expect(getContainer).not.toHaveBeenCalled();
  });

  it("kills only the verified legacy RUN container when its daemon stream times out", async () => {
    const stream = new PassThrough();
    stream.on("error", () => {});
    const buildId = "111111111111";
    const parentId = "aaaaaaaaaaaa";
    const ownershipHost = "openship-build-test.invalid";
    const kill = vi.fn(async () => {});
    const getContainer = vi.fn((id: string) => ({
      inspect: vi.fn(async () => ({
        Id: id.padEnd(64, "1"),
        Config: {
          Image: `sha256:${parentId.padEnd(64, "a")}`,
          Cmd: ["/bin/sh", "-c", "sleep 180"],
        },
        HostConfig: {
          Memory: 512 * 1024 * 1024,
          ExtraHosts: [`${ownershipHost}:127.0.0.1`],
        },
        State: { Running: true },
      })),
      kill,
    }));
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime &
      Record<string, unknown>;
    Object.assign(runtime, {
      _docker: {
        listContainers: vi.fn(),
        getContainer,
        modem: {
          followProgress: vi.fn(
            (
              _stream: unknown,
              _finished: unknown,
              progress: (event: { stream: string }) => void,
            ) => {
              progress({ stream: "Step 1/2 : FROM alpine:3.20\n" });
              progress({ stream: ` ---> ${parentId}\n` });
              progress({ stream: "Step 2/2 : RUN sleep 180\n" });
              progress({ stream: ` ---> Running in ${buildId}\n` });
            },
          ),
        },
      },
    });

    const result = (runtime as any)
      .streamDockerodeBuild(stream, new BuildLogger(), {
        diagnosticContext: { configuredMemoryMb: 512, memoryLimitApplied: true },
        legacyBuilder: { expectedMemoryBytes: 512 * 1024 * 1024, ownershipHost },
      })
      .catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(MIN_DOCKER_BUILD_IDLE_TIMEOUT_MS);

    await expect(result).resolves.toMatchObject({
      message: expect.stringContaining("no output for 1 minute and was cancelled"),
    });
    expect(getContainer).toHaveBeenCalledTimes(2);
    expect(getContainer).toHaveBeenNthCalledWith(1, buildId);
    expect(getContainer).toHaveBeenNthCalledWith(2, buildId);
    expect(kill).toHaveBeenCalledOnce();
  });

  it("waits briefly for Docker's RUN id when cancellation lands at the step boundary", async () => {
    const stream = new PassThrough();
    stream.on("error", () => {});
    const buildId = "111111111111";
    const parentId = "aaaaaaaaaaaa";
    const ownershipHost = "openship-build-test.invalid";
    const kill = vi.fn(async () => {});
    const getContainer = vi.fn((id: string) => ({
      inspect: vi.fn(async () => ({
        Id: id.padEnd(64, "1"),
        Config: {
          Image: `sha256:${parentId.padEnd(64, "a")}`,
          Cmd: ["/bin/sh", "-c", "sleep 180"],
        },
        HostConfig: {
          Memory: 512 * 1024 * 1024,
          ExtraHosts: [`${ownershipHost}:127.0.0.1`],
        },
        State: { Running: true },
      })),
      kill,
    }));
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime &
      Record<string, unknown>;
    Object.assign(runtime, {
      _docker: {
        getContainer,
        modem: {
          followProgress: vi.fn(
            (
              _stream: unknown,
              _finished: unknown,
              progress: (event: { stream: string }) => void,
            ) => {
              progress({ stream: "Step 1/2 : FROM alpine:3.20\n" });
              progress({ stream: ` ---> ${parentId}\n` });
              progress({ stream: "Step 2/2 : RUN sleep 180\n" });
              setTimeout(() => progress({ stream: ` ---> Running in ${buildId}\n` }), 100);
            },
          ),
        },
      },
    });
    const cancel = new AbortController();
    const abortBuild = vi.fn();
    const result = (runtime as any)
      .streamDockerodeBuild(stream, new BuildLogger(), {
        diagnosticContext: { configuredMemoryMb: 512, memoryLimitApplied: true },
        legacyBuilder: { expectedMemoryBytes: 512 * 1024 * 1024, ownershipHost },
        abortBuild,
        cancelSignal: cancel.signal,
      })
      .catch((error: Error) => error);

    cancel.abort();
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toMatchObject({ name: "BuildCancelledError" });
    expect(kill).toHaveBeenCalledOnce();
    expect(abortBuild).toHaveBeenCalledOnce();
  });

  it("applies the same inactivity deadline to native SSH builds", async () => {
    const streamExec = vi.fn(
      async (
        _command: string,
        _onLog: Parameters<CommandExecutor["streamExec"]>[1],
        opts?: Parameters<CommandExecutor["streamExec"]>[2],
      ) => {
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { code: 0, output: "" };
      },
    );
    const executor = {
      exec: vi.fn(async () => ""),
      streamExec,
    } as unknown as CommandExecutor;
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime &
      Record<string, unknown>;
    Object.assign(runtime, { connectionOptions: { executor } });

    const result = (runtime as any)
      .buildImageOnRemote(
        buildConfig(),
        "/tmp/diagnostic-build",
        "Dockerfile",
        "openship/diagnostic:bld_test",
        new BuildLogger(),
      )
      .catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(MIN_DOCKER_BUILD_IDLE_TIMEOUT_MS);

    await expect(result).resolves.toMatchObject({
      message: expect.stringContaining("no output for 1 minute and was cancelled"),
    });
    expect(streamExec.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  });

  it("uses streamed exit-137 evidence for native SSH build failures", async () => {
    const streamExec = vi.fn(
      async (_command: string, onLog: Parameters<CommandExecutor["streamExec"]>[1]) => {
        onLog({
          timestamp: new Date().toISOString(),
          level: "error",
          message: "The command '/bin/sh -c npm run build' returned a non-zero code: 137\n",
        });
        return { code: 1, output: "" };
      },
    );
    const executor = {
      exec: vi.fn(async () => ""),
      streamExec,
    } as unknown as CommandExecutor;
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime &
      Record<string, unknown>;
    Object.assign(runtime, { connectionOptions: { executor } });

    const error = await (runtime as any)
      .buildImageOnRemote(
        buildConfig(),
        "/tmp/diagnostic-build",
        "Dockerfile",
        "openship/diagnostic:bld_test",
        new BuildLogger(),
      )
      .catch((caught: Error) => caught);

    expect(error.message).toContain("killed by SIGKILL (exit code 137)");
    expect(error.message).toContain("not under an OpenShip-enforced memory cap");
  });
});
