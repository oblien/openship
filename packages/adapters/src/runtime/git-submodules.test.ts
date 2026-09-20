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
import { CloudRuntime } from "./cloud";

const exec = promisify(execFile);
let fixture: string;
let parent: string;
let pinned: string;

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

  it("includes recursive dependencies in the cloud Dockerfile context", async () => {
    const workspace = join(fixture, `cloud-${rollback}`);
    const runtime = Object.create(CloudRuntime.prototype);
    Object.assign(runtime, {
      ensureWorkspaceGit: async () => {},
      execAndStream: async (_runtime: unknown, command: string[]) =>
        // Execute the product's workspace script locally, remapping only its
        // isolated filesystem root. No cloud client or provisioned workspace.
        shell(command[2].replaceAll("/openship", workspace)),
    });
    await runtime.cloneDockerfileContext(
      config(rollback),
      { kind: "remote", contextRelativePath: "" },
      {},
      new BuildLogger(),
    );
    await assertSource(join(workspace, "context"), rollback, true);
  });

  it("finds a Dockerfile inside a submodule during cloud source inspection", async () => {
    const workspace = join(fixture, `cloud-inspect-${rollback}`);
    const runtime = Object.create(CloudRuntime.prototype);
    const run = (command: string) => shell(command.replaceAll("/openship", workspace));
    Object.assign(runtime, {
      provisionWorkspace: async () => ({ workspaceId: "test-workspace", runtime: {} }),
      trackActiveBuildWorkspace: () => {},
      untrackActiveBuildWorkspace: () => {},
      ensureWorkspaceGit: async () => {},
      workspaceExecutor: () => ({
        exec: run,
        streamExec: async (command: string) => ({ code: 0, output: await run(command) }),
      }),
      ws: () => ({ delete: async () => {} }),
    });
    const source = await runtime.resolveRemoteDockerfileBuildSource(
      { ...config(rollback), buildContextDirectory: "lib/auth" },
      new BuildLogger(),
    );
    expect(source.dockerfile).toBe("FROM scratch\nCOPY version.txt /version\n");
    await source.cleanup();
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
