import { describe, expect, it, vi } from "vitest";
import { protectedBuildCacheHostExecutor } from "./docker-build-cache-executor";
import { AppError } from "@repo/core";
import { DockerRuntime } from "./docker";
import { BuildLogger } from "./build-pipeline";
import { projectBuildCacheVolume } from "./docker-build-cache";
import { currentManagedCommandTracking, withManagedCommandTracking } from "./cloud/command-tracking";
import type { BuildConfig, LogCallback, LogEntry } from "../types";

vi.mock("./docker-build-cache-executor", () => ({
  protectedBuildCacheHostExecutor: vi.fn(async (executor) => executor),
}));

const config = {
  projectId: "project",
  sessionId: "build",
  resources: { cpuCores: 0.25, memoryMb: 512, diskMb: 8192 },
} as BuildConfig;
function fixture(transport = "cloud", buildKit = true, resources = config.resources) {
  const executor = {
    exec: vi.fn(async (command: string): Promise<string> =>
      command.includes("buildx version") ? (buildKit ? "OPENSHIP_BUILDKIT_OK\n" : "") :
      command.startsWith("docker info --format") ? JSON.stringify({ OSType: "linux", SecurityOptions: [] }) :
      command.startsWith("docker image inspect") ? JSON.stringify([{ Config: { Labels: { "org.openship.build-metadata-policy": "1" }, Entrypoint: ["/usr/local/bin/openship-buildkitd"] } }]) :
      command.includes("df -Pk") ? "104857600 52428800\n200000 100000\n" : "",
    ),
    writeFile: vi.fn(async () => {}),
    streamExec: vi.fn(async (_command: string, _logger: unknown, _options: unknown) => ({
      code: 0,
      output: "",
    })),
  };
  const runtime = Object.assign(Object.create(DockerRuntime.prototype), {
    transport: { kind: transport },
    connectionOptions: { transport, executor },
    _docker: {
      modem: { dial: (_options: unknown, callback: (error: unknown, data: unknown) => void) => callback(null, {}) },
      listVolumes: vi.fn(async () => ({ Volumes: [] })),
      listContainers: vi.fn(async () => []),
      getVolume: () => ({ inspect: async () => ({ Name: projectBuildCacheVolume(config.projectId),
        Labels: { "openship.build-cache": "1", "openship.build-cache.project": config.projectId } }) }),
    },
  });
  vi.spyOn(runtime, "prepareDeploymentImage").mockResolvedValue({} as never);
  return {
    executor,
    runtime,
    commands: () => [...executor.exec.mock.calls.map(call => call[0]), ...executor.streamExec.mock.calls.map(call => call[0])].join("\n"),
    run: (signal?: AbortSignal, onLog?: LogCallback) =>
      runtime.buildImageOnRemote(
        { ...config, resources },
        "/tmp/build dir",
        "Dockerfile",
        "openship/test:build",
        new BuildLogger(onLog),
        { signal },
      ),
  };
}

describe("Cloud Docker build execution limits", () => {
  it("passes verified public OCI images to the real build command without sharing writable state", async () => {
    const h = fixture();
    const original = h.executor.exec.getMockImplementation()!;
    const digest = `sha256:${"a".repeat(64)}`;
    h.executor.exec.mockImplementation(async command => command.startsWith("python3")
      ? JSON.stringify({ platform: "linux/amd64", dockerfile: "FROM oven/bun:1.3.14", pack: { version: 2, platform: "linux/amd64", images: [{ image: "oven/bun:1.3.14", path: "images/bun", digest, sourceDigest: digest }] } })
      : command.includes("imagetools inspect") ? digest : original(command));
    await h.run();
    expect(h.commands()).toContain("--build-context 'oven/bun:1.3.14=oci-layout:///opt/oblien/build-cache/images/bun@");
    expect(h.commands()).not.toContain("--cache-to");
    expect(h.commands()).toContain("--keep-state");
  });
  it("waits for the current build acknowledgement before checking retained cache protection", async () => {
    const h = fixture();
    let pending = false;
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
    Object.assign(h.runtime.connectionOptions, {
      buildCacheProtection: async () => ({ projectIds: pending ? [config.projectId] : [], all: false }),
    });
    const streamExec = h.executor.streamExec.getMockImplementation()!;
    h.executor.streamExec.mockImplementation(async (...args) => {
      const result = await streamExec(...args);
      pending = true;
      currentManagedCommandTracking()!.defer(acknowledgement.then(() => { pending = false; }));
      setImmediate(acknowledge);
      return result;
    });
    await expect(withManagedCommandTracking({ record: async () => {}, complete: async () => {} }, h.run))
      .resolves.toBeUndefined();
    expect(pending).toBe(false);
    expect(h.commands()).toContain("buildx build");
  });
  it("blocks a new worker when a prior command's exit remains unconfirmed", async () => {
    const h = fixture();
    Object.assign(h.runtime.connectionOptions, { buildCacheProtection: async () => ({ projectIds: [config.projectId], all: false }) });
    await expect(h.run()).rejects.toMatchObject({ code: "CLOUD_COMMAND_EXIT_UNCONFIRMED" });
    expect(h.executor.streamExec).not.toHaveBeenCalled();
    expect(h.commands()).not.toContain("buildx create");
  });
  it("refuses a foreign cache before executing source commands", async () => {
    const h = fixture();
    h.runtime._docker.getVolume = () => ({ inspect: async () => ({ Name: projectBuildCacheVolume(config.projectId),
      Labels: { "openship.build-cache": "1", "openship.build-cache.project": "foreign" } }) });
    await expect(h.run()).rejects.toMatchObject({ code: "BUILD_CACHE_OWNER_MISMATCH" });
    expect(h.executor.streamExec).not.toHaveBeenCalled();
    expect(h.commands()).not.toContain("docker volume rm");
  });
  it("refuses storage pressure before worker creation or build execution", async () => {
    const h = fixture();
    const exec = h.executor.exec.getMockImplementation()!;
    h.executor.exec.mockImplementation(command => command.includes("df -Pk") ? Promise.resolve("104857600 0\n0\n") : exec(command));
    await expect(h.run()).rejects.toMatchObject({ code: "BUILD_STORAGE_LOW" });
    expect(h.executor.streamExec).not.toHaveBeenCalled();
    expect(h.commands()).not.toContain("buildx create");
  });
  it.each([
    ["cloud", true],
    ["ssh", true],
  ] as const)(
    "builds with unsupported inode statistics on %s (BuildKit: %s)",
    async (transport, buildKit) => {
      const h = fixture(transport, buildKit);
      const exec = h.executor.exec.getMockImplementation()!;
      h.executor.exec.mockImplementation((command) =>
        command.includes("df -Pk")
          ? Promise.resolve("OPENSHIP_STORAGE 524288000 301989888\nOPENSHIP_INODES 0 0\n")
          : exec(command),
      );
      await expect(h.run()).resolves.toBeUndefined();
      expect(h.executor.streamExec).toHaveBeenCalledOnce();
    },
  );
  it.each(["cloud", "ssh"])(
    "refuses confirmed inode exhaustion before building on %s",
    async (transport) => {
      const h = fixture(transport);
      const exec = h.executor.exec.getMockImplementation()!;
      h.executor.exec.mockImplementation((command) =>
        command.includes("df -Pk")
          ? Promise.resolve("OPENSHIP_STORAGE 524288000 301989888\nOPENSHIP_INODES 1000 0\n")
          : exec(command),
      );
      await expect(h.run()).rejects.toMatchObject({ code: "BUILD_STORAGE_LOW" });
      expect(h.executor.streamExec).not.toHaveBeenCalled();
      expect(h.commands()).not.toContain("buildx create");
    },
  );
  it.each(["cloud", "ssh"])("preserves fragmented %s terminal output without adding line breaks", async transport => {
    const h = fixture(transport);
    const original = "#5 installing dependencies\r\n#5 café ready\r\n";
    const bytes = Buffer.from(original);
    const fragments = [bytes.subarray(0, 3), bytes.subarray(3, 12), bytes.subarray(12, 36), bytes.subarray(36)];
    h.executor.streamExec.mockImplementation(async (_command, logger) => {
      for (const fragment of fragments) (logger as LogCallback)({
        timestamp: new Date().toISOString(), message: fragment.toString(),
        level: "info", rawData: fragment.toString("base64"),
      });
      return { code: 0, output: original };
    });
    const logs: LogEntry[] = [];
    await h.run(undefined, entry => logs.push(entry));
    const streamed = logs.filter(entry => entry.rawData !== undefined);
    expect(Buffer.concat(streamed.map(entry => Buffer.from(entry.rawData!, "base64"))).toString()).toBe(original);
  });
  it.each(["cloud", "ssh"])("omits all build limits when unset on %s", async transport => {
    const h = fixture(transport, true, { cpuCores: 0, memoryMb: 0, diskMb: 0 });
    await h.run();
    const command = h.commands();
    expect(command).not.toContain("memory="); expect(command).not.toContain("--memory"); expect(command).not.toContain("cpu-quota=");
    if (transport === "cloud") {
      expect(command).toContain("--driver docker-container");
      expect(h.commands()).toContain("buildx rm --force");
    }
  });
  it("applies only an explicitly configured dimension", async () => {
    const h = fixture("cloud", true, { cpuCores: 0, memoryMb: 512, diskMb: 0 });
    await h.run();
    const command = h.commands();
    expect(command).toContain("memory=536870912"); expect(command).not.toContain("cpu-quota=");
  });
  it("runs BuildKit inside the selected CPU/RAM budget and loads its image into the project's Docker host", async () => {
    const h = fixture();
    await h.run();
    const command = h.commands();
    expect(command).toContain("--driver docker-container");
    expect(command).toContain("--driver-opt 'memory=536870912'");
    expect(command).toContain("--driver-opt 'memory-swap=536870912'");
    expect(command).toContain("--driver-opt 'cpu-quota=25000'");
    expect(command).toContain("--driver-opt 'cpu-period=100000'");
    expect(command).toContain("--load --progress=plain");
    expect(command).toContain("cd '/tmp/build dir'");
    expect(command).not.toContain("--use");
    expect(command).toContain("trap ");
    expect(h.commands()).toContain("buildx rm --force --keep-state 'openship-");
    expect(command).toContain("--keep-state");
    expect(h.commands()).toContain("--keep-state");
  });
  it.each([1, 137])(
    "stops the project's builder and preserves managed cache after a failed build (exit %s)",
    async (code) => {
      const h = fixture();
      h.executor.streamExec.mockResolvedValue({ code, output: "" });
      await expect(h.run()).rejects.toThrow(`docker build exited with code ${code}`);
      expect(h.commands()).toContain("buildx rm --force --keep-state 'openship-");
      expect(h.commands()).toContain("--keep-state");
      expect(h.commands()).not.toContain("prune");
    },
  );
  it("cleans up the builder after cancellation even if the remote stream resolves normally", async () => {
    const h = fixture();
    const controller = new AbortController();
    h.executor.streamExec.mockImplementation(async () => {
      controller.abort();
      return { code: 0, output: "" };
    });
    await expect(h.run(controller.signal)).rejects.toMatchObject({ name: "BuildCancelledError" });
    expect(h.commands()).toContain("buildx rm --force --keep-state 'openship-");
    expect(h.commands()).toContain("--keep-state");
  });
  it("refuses a Cloud build without BuildKit instead of using the daemon's native builder", async () => {
    const h = fixture("cloud", false);
    await expect(h.run()).rejects.toMatchObject({ code: "BUILD_METADATA_PROTECTION_UNAVAILABLE" });
    expect(h.executor.streamExec).not.toHaveBeenCalled();
    expect(h.commands()).not.toContain("buildx create");
    expect(h.runtime._docker.listVolumes).not.toHaveBeenCalled();
  });
  it("never falls back to the Engine API when the Cloud executor is missing, even with cache mounts disabled", async () => {
    const h = fixture();
    h.runtime.connectionOptions.executor = undefined;
    await expect(
      h.runtime.cachedBuildConfig({ ...config, buildCache: false }),
    ).rejects.toMatchObject({ code: "CLOUD_BUILD_EXECUTOR_UNAVAILABLE" });
    expect(h.executor.exec).not.toHaveBeenCalled();
  });
  it("uses the same protected project worker for self-hosted SSH, with only explicit caps", async () => {
    const h = fixture("ssh");
    await h.run();
    expect(h.commands()).toContain("buildx create");
    expect(h.commands()).toContain("image=ghcr.io/oblien/openship-buildkit:");
    expect(h.commands()).toContain("network=bridge");
    expect(h.commands()).toContain("memory=536870912");
    expect(h.commands()).not.toContain("--allow=");
  });
  it("refuses unsupported SSH builds instead of falling back to an unprotected native builder", async () => {
    const h = fixture("ssh", false);
    await expect(h.run()).rejects.toMatchObject({ code: "BUILD_METADATA_PROTECTION_UNAVAILABLE" });
    expect(h.executor.streamExec).not.toHaveBeenCalled();
  });
  it.each(["cloud", "ssh"])("blocks %s before any worker/source command when host or image verification fails", async transport => {
    const h = fixture(transport);
    const original = h.executor.exec.getMockImplementation()!;
    h.executor.exec.mockImplementation(command => command.startsWith("docker info --format")
      ? Promise.resolve(JSON.stringify({ OSType: "linux", SecurityOptions: ["name=rootless"] })) : original(command));
    await expect(h.run()).rejects.toMatchObject({ code: "BUILD_METADATA_PROTECTION_UNAVAILABLE" });
    expect(h.executor.streamExec).not.toHaveBeenCalled();
    expect(h.commands()).not.toContain("buildx create");
  });
  it("does not run a repository build when the guarded image cannot be acquired", async () => {
    const h = fixture();
    h.runtime.prepareDeploymentImage.mockRejectedValue(new Error("manifest missing"));
    await expect(h.run()).rejects.toMatchObject({ code: "BUILD_METADATA_PROTECTION_UNAVAILABLE" });
    expect(h.executor.streamExec).not.toHaveBeenCalled();
    expect(h.commands()).not.toContain("buildx create");
  });
  it("refuses an SSH login without sudo before worker or repository commands", async () => {
    const h = fixture("ssh");
    vi.mocked(protectedBuildCacheHostExecutor).mockRejectedValueOnce(
      new AppError("Remote build cache requires root or passwordless sudo", 503, "BUILD_METADATA_PROTECTION_UNAVAILABLE"),
    );
    await expect(h.run()).rejects.toMatchObject({ code: "BUILD_METADATA_PROTECTION_UNAVAILABLE" });
    expect(h.executor.streamExec).not.toHaveBeenCalled();
    expect(h.executor.writeFile).not.toHaveBeenCalled();
    expect(h.commands()).not.toContain("buildx create");
    expect(h.commands()).not.toContain("buildx rm");
  });

});
