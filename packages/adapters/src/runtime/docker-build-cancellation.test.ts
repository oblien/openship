import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildConfig, CommandExecutor } from "../types";
import { BuildLogger } from "./build-pipeline";
import { DockerRuntime, packBuildContext } from "./docker";

// The dockerode path clones the repo through this module; the cancellation tests
// care about what happens AFTER a context exists, so hand them a fake one.
const fakeBuildContext = vi.hoisted(() => ({
  current: null as { contextDir: string; cleanup: () => Promise<void> } | null,
}));

vi.mock("./docker-build-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./docker-build-context")>();
  return {
    ...actual,
    createDockerBuildContext: vi.fn(async () => ({
      contextDir: fakeBuildContext.current!.contextDir,
      contextEntries: ["Dockerfile"],
      dockerfileName: "Dockerfile",
      usesRepositoryDockerfile: true,
      cleanup: fakeBuildContext.current!.cleanup,
    })),
  };
});

function buildConfig(sessionId: string): BuildConfig {
  return {
    sessionId,
    projectId: "project-1",
    slug: "cancel-test",
    repoUrl: "https://example.com/repo.git",
    branch: "main",
    stack: "docker",
    buildImage: "",
    packageManager: "",
    installCommand: "",
    buildCommand: "",
    outputDirectory: "",
    port: 8080,
    runtimeImage: "",
    envVars: {},
    resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
    cloneOnServer: true,
  };
}

describe("DockerRuntime build cancellation", () => {
  function runtimeWith(executor: CommandExecutor) {
    const verifyImageBuilt = vi.fn(async () => {});
    const cloneSourceOnRemote = vi.fn(async () => {});
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime &
      Record<string, unknown>;
    Object.assign(runtime, {
      connectionOptions: { executor },
      transport: { kind: "ssh", description: "test ssh" },
      systemManager: null,
      _docker: {
        listContainers: vi.fn(async () => []),
      },
      cloneSourceOnRemote,
      resolveRemoteDockerfile: vi.fn(async () => "Dockerfile"),
      verifyImageBuilt,
    });
    return { runtime, verifyImageBuilt, cloneSourceOnRemote };
  }

  it("aborts the streamed SSH docker build and returns cancelled", async () => {
    let enteredBuild!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      enteredBuild = resolve;
    });

    const executor = {
      exec: vi.fn(async () => ""),
      streamExec: vi.fn(async (_command, _onLog, opts) => {
        enteredBuild();
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { code: 0, output: "" };
      }),
    } as unknown as CommandExecutor;

    const { runtime: buildRuntime, verifyImageBuilt } = runtimeWith(executor);
    const { runtime: cancelRuntime } = runtimeWith(executor);

    const resultPromise = buildRuntime.build(buildConfig("session-1"));
    await buildStarted;
    await cancelRuntime.cancelBuild("session-1");

    await expect(resultPromise).resolves.toMatchObject({
      sessionId: "session-1",
      status: "cancelled",
    });
    expect(executor.streamExec).toHaveBeenCalledWith(
      expect.stringContaining("docker build"),
      expect.any(Function),
      { signal: expect.any(AbortSignal) },
    );
    expect(executor.exec).toHaveBeenCalledWith(
      expect.stringContaining("/tmp/openship-build-session-1"),
    );
    expect(verifyImageBuilt).not.toHaveBeenCalled();
  });

  it("remembers cancellation that arrives before build registration", async () => {
    const executor = {
      exec: vi.fn(async () => ""),
      streamExec: vi.fn(async () => ({ code: 0, output: "" })),
    } as unknown as CommandExecutor;
    const { runtime: buildRuntime, cloneSourceOnRemote, verifyImageBuilt } = runtimeWith(executor);
    const { runtime: cancelRuntime } = runtimeWith(executor);

    await cancelRuntime.cancelBuild("session-queued");
    await expect(buildRuntime.build(buildConfig("session-queued"))).resolves.toMatchObject({
      sessionId: "session-queued",
      status: "cancelled",
    });

    expect(cloneSourceOnRemote).not.toHaveBeenCalled();
    expect(executor.streamExec).not.toHaveBeenCalled();
    expect(verifyImageBuilt).not.toHaveBeenCalled();
  });

  it("kills orphaned remote processes under the session dir, including deleted cwds", async () => {
    const executor = {
      exec: vi.fn(async () => ""),
      streamExec: vi.fn(async () => ({ code: 0, output: "" })),
    } as unknown as CommandExecutor;
    const { runtime } = runtimeWith(executor);

    await runtime.cancelBuild("session-sweep");

    const sweep = (executor.exec as ReturnType<typeof vi.fn>).mock.calls
      .map(([command]) => String(command))
      .find((command) => command.includes("/proc/"))!;
    expect(sweep).toContain("kill -TERM");
    expect(sweep).toContain("kill -KILL");
    // The build's own cleanup rm -rf's the context dir, so by the time the sweep
    // runs Linux reports the cwd as "<dir> (deleted)" — matching only the plain
    // dir would find nothing, which is what made the kill a no-op.
    expect(sweep).toContain(`'/tmp/openship-build-session-sweep'" (deleted)"`);
    // Compose services build in `<parent>-<serviceId>` dirs off the same cancel.
    expect(sweep).toContain(`'/tmp/openship-build-session-sweep'-*`);
  });

  it("cancels every compose service build under the parent session id", async () => {
    let enteredBuild!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      enteredBuild = resolve;
    });
    const executor = {
      exec: vi.fn(async () => ""),
      streamExec: vi.fn(async (_command, _onLog, opts) => {
        enteredBuild();
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { code: 0, output: "" };
      }),
    } as unknown as CommandExecutor;

    const { runtime: buildRuntime, verifyImageBuilt } = runtimeWith(executor);
    const { runtime: cancelRuntime } = runtimeWith(executor);

    const specs = ["svc-a", "svc-b"].map((serviceId) => ({
      config: buildConfig(`parent-1-${serviceId}`),
      serviceName: serviceId,
      logger: new BuildLogger(),
    }));

    const resultsPromise = buildRuntime.buildImages(specs, new BuildLogger());
    await buildStarted;
    // The API cancels with the PARENT build-session id; the services registered
    // under `<parent>-<serviceId>` have to be covered by it.
    await cancelRuntime.cancelBuild("parent-1");

    const results = await resultsPromise;
    expect(results.map((entry) => entry.result.status)).toEqual(["cancelled", "cancelled"]);
    // svc-b never got its turn — sequential builds, so it must not have started.
    expect(executor.streamExec).toHaveBeenCalledTimes(1);
    expect(verifyImageBuilt).not.toHaveBeenCalled();
  });
});

describe("DockerRuntime build cancellation — dockerode path", () => {
  let contextDir: string | null = null;

  afterEach(async () => {
    if (contextDir) await rm(contextDir, { recursive: true, force: true });
    contextDir = null;
    fakeBuildContext.current = null;
  });

  it("returns cancelled instead of deploying when the daemon build is aborted", async () => {
    contextDir = await mkdtemp(join(tmpdir(), "openship-cancel-"));
    await writeFile(join(contextDir, "Dockerfile"), "FROM scratch\n");
    fakeBuildContext.current = { contextDir, cleanup: async () => {} };

    let enteredBuild!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      enteredBuild = resolve;
    });

    const verifyImageBuilt = vi.fn(async () => {});
    const buildImage = vi.fn(async (_body: unknown, opts: { abortSignal: AbortSignal }) => {
      enteredBuild();
      await new Promise<void>((resolve) => {
        opts.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("The operation was aborted");
    });

    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime &
      Record<string, unknown>;
    Object.assign(runtime, {
      // No executor: local socket / TCP, so build() takes the dockerode path.
      connectionOptions: {},
      transport: { kind: "socket", description: "local socket" },
      systemManager: null,
      _docker: { buildImage, listContainers: vi.fn(async () => []) },
      estimateContextSize: vi.fn(async () => 0),
      verifyImageBuilt,
    });

    const config = { ...buildConfig("session-dockerode"), cloneOnServer: false };
    const resultPromise = runtime.build(config);
    await buildStarted;
    await runtime.cancelBuild("session-dockerode");

    // The pipeline stops ONLY on "cancelled" and otherwise re-writes the row to
    // "deploying" — a "failed"/"deploying" result here deploys a cancelled deploy.
    await expect(resultPromise).resolves.toMatchObject({
      sessionId: "session-dockerode",
      status: "cancelled",
    });
    expect(verifyImageBuilt).not.toHaveBeenCalled();
  });
});

describe("packBuildContext", () => {
  let contextDir: string | null = null;

  afterEach(async () => {
    if (contextDir) await rm(contextDir, { recursive: true, force: true });
    contextDir = null;
  });

  it("aborts the daemon request when the build's cancel signal fires", async () => {
    contextDir = await mkdtemp(join(tmpdir(), "openship-pack-"));
    await writeFile(join(contextDir, "Dockerfile"), "FROM scratch\n");

    const cancel = new AbortController();
    const packed = packBuildContext(contextDir, ["Dockerfile"], cancel.signal);
    expect(packed.abortSignal.aborted).toBe(false);
    cancel.abort();
    expect(packed.abortSignal.aborted).toBe(true);
    expect(packed.takeError()).toBeNull();
    packed.body.resume();
  });

  it("starts aborted when the build was already cancelled", async () => {
    contextDir = await mkdtemp(join(tmpdir(), "openship-pack-"));
    await writeFile(join(contextDir, "Dockerfile"), "FROM scratch\n");

    const packed = packBuildContext(contextDir, ["Dockerfile"], AbortSignal.abort());
    expect(packed.abortSignal.aborted).toBe(true);
    packed.body.resume();
  });
});
