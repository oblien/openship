import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BuildConfig, CommandExecutor } from "../types";
import { BuildLogger, runBuildPipeline } from "./build-pipeline";
import { prepareSourceTree } from "./docker-build-context";
import { DockerRuntime } from "./docker";

const exec = promisify(execFile);
let fixture: string;
let parent: string;
let pinned: string;
let mergeCommit: string;

async function git(directory: string, ...args: string[]) {
  const { stdout } = await exec("git", ["-C", directory, ...args]);
  return stdout.trim();
}

async function commit(directory: string) {
  await git(directory, "add", "-A");
  await git(
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  return git(directory, "rev-parse", "HEAD");
}

async function repository(name: string) {
  const directory = join(fixture, name);
  await mkdir(directory);
  await git(directory, "init", "-qb", "main");
  return directory;
}

beforeAll(async () => {
  // Local fixtures only; production retains Git's default protocol policy.
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
  fixture = await mkdtemp(join(tmpdir(), "git-submodules-"));
  const nested = await repository("nested");
  await writeFile(join(nested, "nested.txt"), "nested dependency\n");
  await commit(nested);
  const dependency = await repository("dependency");
  await writeFile(join(dependency, "version.txt"), "one\n");
  await writeFile(join(dependency, "Dockerfile"), "FROM scratch\nCOPY version.txt /version\n");
  await git(dependency, "submodule", "add", pathToFileURL(nested).href, "nested");
  await git(dependency, "config", "-f", ".gitmodules", "submodule.nested.url", "../nested");
  await commit(dependency);
  parent = await repository("parent");
  await writeFile(join(parent, "Dockerfile"), "FROM scratch\nCOPY lib/auth /auth\n");
  await git(parent, "submodule", "add", pathToFileURL(dependency).href, "lib/auth");
  await git(parent, "config", "-f", ".gitmodules", "submodule.lib/auth.url", "../dependency");
  pinned = await commit(parent);
  await writeFile(join(dependency, "version.txt"), "two\n");
  const newer = await commit(dependency);
  await git(join(parent, "lib/auth"), "fetch", "origin", "main");
  await git(join(parent, "lib/auth"), "checkout", newer);
  await commit(parent);
  // A rollback must not initialize the broken branch HEAD before it selects
  // the requested commit. clone --recurse-submodules gets this ordering wrong.
  await git(parent, "checkout", "-qb", "broken");
  await git(parent, "config", "-f", ".gitmodules", "submodule.lib/auth.url", "../missing");
  await commit(parent);
  // Like a PR merge commit: only a pull ref reaches it, never the cloned branch.
  await git(parent, "checkout", "-qb", "merge", "main");
  await writeFile(join(parent, "merge.txt"), "tested merge\n");
  mergeCommit = await commit(parent);
  await git(parent, "update-ref", "refs/pull/1/merge", mergeCommit);
  await git(parent, "checkout", "-q", "main");
  await git(parent, "branch", "-qD", "merge");
}, 30_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

function config(rollback: boolean): BuildConfig {
  return {
    sessionId: "submodules",
    projectId: "project",
    slug: "project",
    repoUrl: pathToFileURL(parent).href,
    branch: rollback ? "broken" : "main",
    ...(rollback ? { commitSha: pinned } : {}),
    stack: "docker",
    buildImage: "",
    runtimeImage: "",
    packageManager: "",
    installCommand: "",
    buildCommand: "",
    outputDirectory: "",
    port: 3000,
    envVars: {},
    resources: { cpuCores: 1, memoryMb: 256, diskMb: 1024 },
  };
}

async function shell(command: string) {
  const { stdout } = await exec("sh", ["-c", command], { timeout: 15_000 });
  return stdout;
}

async function assertSource(directory: string, rollback: boolean, stripMetadata: boolean) {
  expect(await readFile(join(directory, "lib/auth/version.txt"), "utf8")).toBe(
    rollback ? "one\n" : "two\n",
  );
  expect(await readFile(join(directory, "lib/auth/nested/nested.txt"), "utf8")).toBe(
    "nested dependency\n",
  );
  if (stripMetadata) {
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        expect(entry.name).not.toBe(".git");
        if (entry.isDirectory()) await walk(join(directory, entry.name));
      }
    };
    await walk(directory);
  }
}

describe.each([false, true])("Git submodule materialization (rollback=%s)", (rollback) => {
  it("includes recursive dependencies in the orchestrator Docker source tree", async () => {
    const tree = await prepareSourceTree(config(rollback));
    try {
      await assertSource(tree.contextDir, rollback, true);
    } finally {
      await tree.cleanup();
    }
  });

  it("includes recursive dependencies in the server Docker source tree", async () => {
    const target = join(fixture, `server-${rollback}`);
    const executor = {
      exec: shell,
      streamExec: async (command: string) => ({ code: 0, output: await shell(command) }),
    } as unknown as CommandExecutor;
    const runtime = Object.create(DockerRuntime.prototype);
    Object.assign(runtime, { connectionOptions: { executor } });
    await runtime.cloneSourceOnRemote(config(rollback), target, new BuildLogger());
    await assertSource(target, rollback, true);
  });

  it("includes recursive dependencies before the shared pipeline's build starts", async () => {
    const target = join(fixture, `pipeline-${rollback}`);
    const result = await runBuildPipeline(
      {
        projectDir: target,
        exec: async (command) => {
          await shell(command);
        },
      },
      config(rollback),
      new BuildLogger(),
    );
    expect(result.status).toBe("deploying");
    await assertSource(target, rollback, false);
  });
});

it("fails the clone step for an unavailable submodule before executing a build", async () => {
  const build = vi.fn(async (command: string) => {
    await shell(command);
  });
  const broken = { ...config(false), branch: "broken", installCommand: "echo must-not-build" };
  const result = await runBuildPipeline(
    { projectDir: join(fixture, "unavailable"), exec: build },
    broken,
    new BuildLogger(),
  );
  expect(result).toMatchObject({ status: "failed", failedStep: "clone" });
  expect(build.mock.calls.every(([command]) => !command.includes("must-not-build"))).toBe(true);
});

describe("a pinned commit outside the cloned branch (#1544)", () => {
  const pinnedTo = (commitSha: string) => ({ ...config(false), commitSha });
  const serverRuntime = () => {
    const runtime = Object.create(DockerRuntime.prototype);
    Object.assign(runtime, {
      connectionOptions: {
        executor: {
          exec: shell,
          streamExec: async (command: string) => {
            try {
              return { code: 0, output: await shell(command) };
            } catch {
              return { code: 1, output: "" };
            }
          },
        } as unknown as CommandExecutor,
      },
    });
    return runtime;
  };
  const pipeline = (target: string, commitSha: string) =>
    runBuildPipeline(
      {
        projectDir: target,
        exec: async (command) => {
          await shell(command);
        },
      },
      pinnedTo(commitSha),
      new BuildLogger(),
    );

  it("checks it out in the orchestrator source tree", async () => {
    const tree = await prepareSourceTree(pinnedTo(mergeCommit));
    try {
      expect(await readFile(join(tree.contextDir, "merge.txt"), "utf8")).toBe("tested merge\n");
    } finally {
      await tree.cleanup();
    }
  });

  it("checks it out in the server source tree", async () => {
    const target = join(fixture, "merge-server");
    await serverRuntime().cloneSourceOnRemote(pinnedTo(mergeCommit), target, new BuildLogger());
    expect(await readFile(join(target, "merge.txt"), "utf8")).toBe("tested merge\n");
  });

  it("checks it out in the shared pipeline", async () => {
    const target = join(fixture, "merge-pipeline");
    expect((await pipeline(target, mergeCommit)).status).toBe("deploying");
    expect(await readFile(join(target, "merge.txt"), "utf8")).toBe("tested merge\n");
  });

  it("fails rather than building branch HEAD when the commit does not exist", async () => {
    const missing = "1".repeat(40);
    await expect(prepareSourceTree(pinnedTo(missing))).rejects.toThrow();
    await expect(
      serverRuntime().cloneSourceOnRemote(
        pinnedTo(missing),
        join(fixture, "missing-server"),
        new BuildLogger(),
      ),
    ).rejects.toThrow();
    expect(await pipeline(join(fixture, "missing-pipeline"), missing)).toMatchObject({
      status: "failed",
      failedStep: "clone",
    });
  });
});
