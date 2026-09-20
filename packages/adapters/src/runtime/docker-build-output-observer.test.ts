import { PassThrough } from "node:stream";
import Dockerode from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { statusResponse } from "../../test/fixtures/docker-buildkit";
import type { BuildConfig, CommandExecutor, LogEntry } from "../types";
import { BuildLogger } from "./build-pipeline";
import { DockerRuntime } from "./docker";
import { BuildKitTraceDecoder } from "./docker-buildkit-trace";

describe("raw Docker build output observers", () => {
  it("does not publish an observed fragment as another user-visible log entry", () => {
    const onLog = vi.fn();
    const onOutput = vi.fn();
    const logger = new BuildLogger(onLog, onOutput);

    logger.observeBuildOutput("an unfinished fragment");
    expect(onOutput).toHaveBeenCalledWith("an unfinished fragment", "default");
    expect(onLog).not.toHaveBeenCalled();

    logger.log("rendered output");
    expect(onLog).toHaveBeenCalledOnce();
    expect(onLog.mock.calls[0]?.[0].message).toBe("rendered output");
    expect(onOutput).toHaveBeenCalledOnce();
  });

  it.each(["classic", "buildkit stdout", "buildkit stderr"])(
    "observes %s fragments before rendering while leaving build success intact",
    async (builder) => {
      const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
      Object.assign(runtime, {
        _docker: new Dockerode({ socketPath: "/tmp/openship-test-absent.sock" }),
      });
      const chunks = ["getaddrinfo ENO", "TFOUND db", ".example.com\n", "\n"];
      const outputStream = builder === "buildkit stderr" ? 2 : 1;
      const events = chunks.map((chunk) =>
        builder === "classic"
          ? { stream: chunk }
          : {
              id: "moby.buildkit.trace",
              aux: statusResponse({
                logs: [{ vertex: "sha256:build", stream: outputStream, msg: chunk }],
              }),
            },
      );

      const run = async (onOutput?: (data: string, streamId: string) => void) => {
        const entries: LogEntry[] = [];
        const stream = new PassThrough();
        const result = (runtime as any).streamDockerodeBuild(
          stream,
          new BuildLogger((entry) => entries.push(entry), onOutput),
          { trace: new BuildKitTraceDecoder() },
        );
        stream.end(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
        await expect(result).resolves.toBeUndefined();
        return entries.map(({ message, level, rawData }) => ({ message, level, rawData }));
      };

      const baseline = await run();
      const onOutput = vi.fn();
      expect(await run(onOutput)).toEqual(baseline);
      expect(onOutput.mock.calls).toEqual(
        chunks.map((chunk) => [
          chunk,
          builder === "classic" ? "default" : `sha256:build:${outputStream}`,
        ]),
      );
    },
  );

  it("keeps SSH stdout and stderr fragments separate without duplicating visible logs", async () => {
    const chunks: LogEntry[] = [
      { timestamp: "", level: "info", message: "getaddrinfo ENO" },
      { timestamp: "", level: "warn", message: "unrelated stderr\n" },
      { timestamp: "", level: "info", message: "TFOUND db\n" },
    ];
    const executor = {
      exec: vi.fn(async () => ""),
      streamExec: vi.fn(
        async (_command: string, onLog: Parameters<CommandExecutor["streamExec"]>[1]) => {
          for (const chunk of chunks) onLog(chunk);
          return { code: 0, output: "" };
        },
      ),
    } as unknown as CommandExecutor;
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
    Object.assign(runtime, { connectionOptions: { executor } });
    const onOutput = vi.fn();
    const entries: LogEntry[] = [];
    const config: BuildConfig = {
      sessionId: "observer-build",
      projectId: "project",
      slug: "example",
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
      resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
    };

    await expect(
      (runtime as any).buildImageOnRemote(
        config,
        "/tmp/observer-build",
        "Dockerfile",
        "openship/example:build",
        new BuildLogger((entry) => entries.push(entry), onOutput),
      ),
    ).resolves.toBeUndefined();

    expect(onOutput.mock.calls).toEqual(chunks.map((chunk) => [chunk.message, chunk.level]));
    for (const chunk of chunks) {
      expect(entries.filter((entry) => entry.message === chunk.message)).toHaveLength(1);
    }
  });
});
