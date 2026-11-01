import { afterEach, describe, expect, it, vi } from "vitest";
import * as tarball from "./source-tarball";
import type { BuildConfig, CommandExecutor } from "../types";
import { BuildLogger } from "./build-pipeline";
import { DockerRuntime } from "./docker";

const COMMIT = "30a396bda22eda34bcd2bc73d5b601683b146e7a";

afterEach(() => vi.restoreAllMocks());

function config(): BuildConfig {
  return {
    sessionId: "bld-clone-test",
    projectId: "project-1",
    slug: "openship",
    repoUrl: "https://github.com/oblien/openship.git",
    branch: "main",
    commitSha: COMMIT,
    gitCredentialHelperPath: "/tmp/relay-helper.sh",
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
}

type CloneHarness = {
  cloneSourceOnRemote(
    config: BuildConfig,
    remoteContextDir: string,
    logger: BuildLogger,
  ): Promise<void>;
};

function harness(executor: CommandExecutor): CloneHarness {
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime & Record<string, unknown>;
  Object.assign(runtime, { connectionOptions: { executor } });
  return runtime as unknown as CloneHarness;
}

describe("DockerRuntime clone-on-server pinned commit", () => {
  it.each([false, true])(
    "uses Git only when the downloaded archive has submodules: %s",
    async (hasSubmodules) => {
      vi.spyOn(tarball, "downloadTarballOnRemote").mockResolvedValue(undefined);
      const streamExec = vi.fn(async (_command: string) => ({ code: 0, output: "" }));
      const executor = {
        exec: vi.fn(async (command: string) => {
          if (command.startsWith("test -f ") && !hasSubmodules) throw new Error("file absent");
          return "";
        }),
        streamExec,
      } as unknown as CommandExecutor;
      await harness(executor).cloneSourceOnRemote(
        { ...config(), gitCredentialHelperPath: undefined },
        "/tmp/openship-build-test",
        new BuildLogger(),
      );
      expect(tarball.downloadTarballOnRemote).toHaveBeenCalledOnce();
      const commands = streamExec.mock.calls.map(([command]) => String(command));
      expect(commands.some((command) => command.includes(" submodule update "))).toBe(
        hasSubmodules,
      );
      expect(commands.some((command) => command.includes(" clone "))).toBe(hasSubmodules);
    },
  );

  it("surfaces a clone failure without attempting fetch in a non-repository", async () => {
    const executor = {
      exec: vi.fn(async () => ""),
      streamExec: vi.fn(async () => ({ code: 128, output: "" })),
    } as unknown as CommandExecutor;

    await expect(
      harness(executor).cloneSourceOnRemote(
        config(),
        "/tmp/openship-build-test",
        new BuildLogger(),
      ),
    ).rejects.toThrow("git clone on server exited with code 128");

    expect(executor.streamExec).toHaveBeenCalledTimes(1);
    const command = String((executor.streamExec as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(command).toContain(" clone ");
    expect(command).not.toContain("--unshallow");
  });

  it("fetches full history only after the clone succeeds and the commit probe misses", async () => {
    const executor = {
      exec: vi.fn(async (command: string) => {
        if (command.includes(" cat-file ")) throw new Error("unknown commit");
        return "";
      }),
      streamExec: vi.fn(async () => ({ code: 0, output: "" })),
    } as unknown as CommandExecutor;

    await harness(executor).cloneSourceOnRemote(
      config(),
      "/tmp/openship-build-test",
      new BuildLogger(),
    );

    const commands = (executor.streamExec as ReturnType<typeof vi.fn>).mock.calls.map(([command]) =>
      String(command),
    );
    expect(commands).toHaveLength(4);
    expect(commands[0]).toContain(" clone ");
    expect(commands[1]).toContain("--unshallow");
    expect(commands[2]).toContain(" checkout ");
    expect(commands[3]).toContain(" submodule update ");
    for (const command of commands.slice(0, 2)) {
      expect(command.indexOf("auth-header")).toBeLessThan(command.indexOf("git "));
    }
  });
});
