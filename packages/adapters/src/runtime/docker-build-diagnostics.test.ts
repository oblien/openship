import { PassThrough } from "node:stream";
import Dockerode from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { statusResponse } from "../../test/fixtures/docker-buildkit";
import type { BuildConfig, CommandExecutor } from "../types";
import { BuildLogger } from "./build-pipeline";
import { BuildKitTraceDecoder } from "./docker-buildkit-trace";
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
    "Process exit with code: 0",
    "Process exited with exit code: 0",
    "process completed: exit code 0",
    "#8 0.021 @workspace/web build: Exited with code 0",
    "Process exited with code 000",
    "@workspace/api build: Exited with code 0\n@workspace/web build: Exited with code 0",
  ])("does not treat a successful exit as failure evidence: %s", (line) => {
    expect(extractDockerBuildFailureHint(line)).toBeNull();
  });

  it.each([1, 2, 126, 127])("preserves a genuine non-zero exit: %s", (code) => {
    const line = `The command returned a non-zero code: ${code}`;
    expect(extractDockerBuildFailureHint(line)).toBe(line);
  });

  it.each(["Process exit with code 1", "Process EXIT WITH CODE: 2"])(
    "recognizes present-tense exit wording: %s",
    (line) => {
      expect(extractDockerBuildFailureHint(line)).toBe(line);
    },
  );

  it.each([
    ["Process exited with code 1", "Process exited with code 1"],
    ["Process exit with code 137", "killed by SIGKILL (exit code 137)"],
    ["Process exited with code 137", "killed by SIGKILL (exit code 137)"],
    ["Process exited with code 143", "received SIGTERM (exit code 143)"],
    ["FATAL ERROR: JavaScript heap out of memory", "explicitly reported that it ran out of memory"],
    ["npm ERR! code ENOMEM", "could not allocate memory (ENOMEM)"],
  ])("retains failure evidence after successful output in the same chunk: %s", (failure, hint) => {
    const output = `@workspace/web build: Exited with code 0\n${failure}`;
    expect(extractDockerBuildFailureHint(output)).toContain(hint);
  });

  it("does not let success output replace or mask a genuine failure hint", () => {
    const success = extractDockerBuildFailureHint("@workspace/web build: Exited with code 0");
    const failure = extractDockerBuildFailureHint("Process exited with code 1");
    expect(chooseDockerBuildFailureHint(failure, success)).toBe(failure);
    expect(chooseDockerBuildFailureHint(success, failure)).toBe(failure);
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

  describe.each(["classic", "buildkit stdout", "buildkit stderr"])(
    "%s Engine API output",
    (builder) => {
      const success = "@beacon/web build: Exited with code 0";
      const failure = "Process exited with code 1";

      const scenarios: Array<{
        name: string;
        lines: string[];
        errorEvent?: { error?: string; errorDetail?: { message?: string } };
        completionError?: Error;
        expectedError: string | null;
        expectedHint?: string;
      }> = [
        { name: "successful build", lines: [success], expectedError: null },
        { name: "cached build without command output", lines: [], expectedError: null },
        {
          name: "handled nonzero exit after success",
          lines: [success, failure],
          expectedError: null,
        },
        {
          name: "handled nonzero exit before success",
          lines: [failure, success],
          expectedError: null,
        },
        {
          name: "handled allocator error",
          lines: [success, "npm ERR! code ENOMEM"],
          expectedError: null,
        },
        {
          name: "failure-looking test output",
          lines: ["fixture: failed to solve: exit code: 1", "error: build", success],
          expectedError: null,
        },
        {
          name: "handled BuildKit diagnostic",
          lines: ["the --mount option requires BuildKit", success],
          expectedError: null,
        },
        {
          name: "handled package lookup error",
          lines: ["ENOENT: /workspace/package.json", success],
          expectedError: null,
        },
        {
          name: "Docker error event",
          lines: [success],
          errorEvent: { error: "The command returned a non-zero code: 1" },
          expectedError: "The command returned a non-zero code: 1",
        },
        {
          name: "Docker error detail mentioning zero",
          lines: [success],
          errorEvent: {
            errorDetail: { message: "Export failed after a tool reported exit code: 0" },
          },
          expectedError: "Export failed after a tool reported exit code: 0",
        },
        {
          name: "empty error detail with a real Docker error",
          lines: [success],
          errorEvent: { errorDetail: { message: "" }, error: "Image export failed" },
          expectedError: "Image export failed",
        },
        {
          name: "error detail preferred to the generic Docker error",
          lines: [success],
          errorEvent: { error: "Build failed", errorDetail: { message: "Image export failed" } },
          expectedError: "Image export failed",
        },
        {
          name: "real Docker failure with allocator evidence",
          lines: [success, "npm ERR! code ENOMEM"],
          errorEvent: { error: "failed to solve: process exited with code 1" },
          expectedError: "failed to solve: process exited with code 1",
          expectedHint: "could not allocate memory (ENOMEM)",
        },
        {
          name: "real Docker failure after unrelated failure-looking output",
          lines: [failure, success],
          errorEvent: { error: "Image export failed" },
          expectedError: "Image export failed",
        },
        {
          name: "transport failure after a successful step",
          lines: [success],
          completionError: new Error("Docker connection closed"),
          expectedError: "Docker connection closed",
        },
        {
          name: "transport failure after allocator-looking output",
          lines: ["npm ERR! code ENOMEM", success],
          completionError: new Error("Docker connection closed"),
          expectedError: "Docker connection closed",
        },
      ];

      it.each(scenarios)("respects the final result for $name", async (scenario) => {
        const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
        const trace = new BuildKitTraceDecoder();
        const onLog = vi.fn();
        Object.assign(runtime, {
          _docker: new Dockerode({ socketPath: "/tmp/openship-test-absent.sock" }),
        });
        const stream = new PassThrough();
        const result = (runtime as any).streamDockerodeBuild(stream, new BuildLogger(onLog), {
          trace,
        });
        const events: object[] = scenario.lines.map((message) =>
          builder === "classic"
            ? { stream: `${message}\n` }
            : {
                id: "moby.buildkit.trace",
                aux: statusResponse({
                  logs: [
                    {
                      vertex: "sha256:build",
                      stream: builder === "buildkit stderr" ? 2 : 1,
                      msg: `${message}\n`,
                    },
                  ],
                }),
              },
        );
        if (scenario.errorEvent) events.push(scenario.errorEvent);
        events.push({ stream: "Successfully built abc123\n" });
        events.push({ stream: "Successfully tagged openship/test:build\n" });
        const output = events.map((event) => `${JSON.stringify(event)}\n`).join("");
        const splitAt = Math.floor(output.length / 2);
        stream.write(output.slice(0, splitAt));
        stream.write(output.slice(splitAt));

        if (scenario.completionError) stream.destroy(scenario.completionError);
        else stream.end();

        if (scenario.expectedError) {
          await expect(result).rejects.toThrow(scenario.expectedError);
        } else {
          await expect(result).resolves.toBeUndefined();
        }
        if (scenario.expectedHint) await expect(result).rejects.toThrow(scenario.expectedHint);
        if (scenario.completionError) await expect(result).rejects.toBe(scenario.completionError);
        for (const line of scenario.lines) {
          expect(onLog).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining(line) }),
          );
        }
        expect(vi.getTimerCount()).toBe(0);
      });
    },
  );

  it.each([false, true])(
    "uses the final Docker result after a BuildKit vertex error (failed=%s)",
    async (failed) => {
      const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
      Object.assign(runtime, {
        _docker: new Dockerode({ socketPath: "/tmp/openship-test-absent.sock" }),
      });
      const stream = new PassThrough();
      const onLog = vi.fn();
      const result = (runtime as any).streamDockerodeBuild(stream, new BuildLogger(onLog), {
        trace: new BuildKitTraceDecoder(),
      });
      stream.write(
        `${JSON.stringify({
          id: "moby.buildkit.trace",
          aux: statusResponse({
            vertexes: [
              {
                digest: "sha256:cache",
                name: "importing cache manifest",
                error: "failed to solve: cache manifest not found",
              },
            ],
          }),
        })}\n`,
      );
      if (failed) stream.write(`${JSON.stringify({ error: "Build failed: cache is required" })}\n`);
      stream.end();

      if (failed) await expect(result).rejects.toThrow("Build failed: cache is required");
      else await expect(result).resolves.toBeUndefined();
      expect(onLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("cache manifest not found"),
        }),
      );
      expect(vi.getTimerCount()).toBe(0);
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

  it.each([0, 1, 2, 126, 127, 137, 143])(
    "uses the actual SSH exit code %s after successful process output",
    async (code) => {
      const executor = {
        exec: vi.fn(async () => ""),
        streamExec: vi.fn(
          async (_command: string, onLog: Parameters<CommandExecutor["streamExec"]>[1]) => {
            onLog({
              timestamp: new Date().toISOString(),
              level: "info",
              message: "@beacon/web build: Exited with code 0",
            });
            return { code, output: "" };
          },
        ),
      } as unknown as CommandExecutor;
      const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
      Object.assign(runtime, { connectionOptions: { executor } });

      const result = (runtime as any).buildImageOnRemote(
        buildConfig(),
        "/tmp/diagnostic-build",
        "Dockerfile",
        "openship/diagnostic:bld_test",
        new BuildLogger(),
      );
      if (code === 0) {
        await expect(result).resolves.toBeUndefined();
      } else {
        await expect(result).rejects.toThrow(`docker build exited with code ${code}`);
      }
    },
  );

  it.each([
    "Process exited with code 1",
    "npm ERR! code ENOMEM",
    "FATAL ERROR: JavaScript heap out of memory",
    "the --mount option requires BuildKit",
    "ENOENT: /workspace/package.json",
  ])("does not override successful SSH completion with diagnostic text: %s", async (message) => {
    const executor = {
      exec: vi.fn(async () => ""),
      streamExec: vi.fn(
        async (_command: string, onLog: Parameters<CommandExecutor["streamExec"]>[1]) => {
          onLog({ timestamp: new Date().toISOString(), level: "error", message });
          return { code: 0, output: "" };
        },
      ),
    } as unknown as CommandExecutor;
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
    Object.assign(runtime, { connectionOptions: { executor } });

    await expect(
      (runtime as any).buildImageOnRemote(
        buildConfig(),
        "/tmp/diagnostic-build",
        "Dockerfile",
        "openship/diagnostic:bld_test",
        new BuildLogger(),
      ),
    ).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
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
