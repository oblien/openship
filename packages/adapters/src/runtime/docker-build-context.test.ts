import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import type { BuildConfig } from "../types";

import { createDockerBuildContext, prepareSourceTree } from "./docker-build-context";

const exec = promisify(execFile);

const cleanups: Array<() => Promise<void>> = [];

/** A git repo with `build/` and `node_modules/` at the root AND nested, a
 *  `Dockerfile`, and the given `.dockerignore`. Everything is tracked. */
async function makeRepo(dockerignore: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "dbc-repo-"));
  cleanups.push(() => rm(repo, { recursive: true, force: true }));

  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await exec("git", ["-C", repo, "config", "commit.gpgsign", "false"]);

  await writeFile(join(repo, ".dockerignore"), dockerignore);
  await writeFile(join(repo, "Dockerfile"), "FROM node:22\nCOPY . /app\n");
  await writeFile(join(repo, "package.json"), '{"name":"ctx","version":"0.1.0"}');

  await mkdir(join(repo, "app", "build"), { recursive: true });
  await writeFile(join(repo, "app", "build", "page.tsx"), "export default () => null;\n");

  await mkdir(join(repo, "build"), { recursive: true });
  await writeFile(join(repo, "build", "artifact.txt"), "generated\n");

  await mkdir(join(repo, "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 0;\n");

  await mkdir(join(repo, "packages", "ui", "node_modules", "left-pad"), { recursive: true });
  await writeFile(
    join(repo, "packages", "ui", "node_modules", "left-pad", "index.js"),
    "module.exports = 0;\n",
  );

  await exec("git", ["-C", repo, "add", "-A", "-f"]);
  await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);

  return repo;
}

function config(localPath: string): BuildConfig {
  return {
    sessionId: "s1",
    projectId: "p1",
    repoUrl: "",
    branch: "main",
    localPath,
    stack: "node",
    buildImage: "node:22",
    runtimeImage: "node:22",
    packageManager: "npm",
    installCommand: "npm ci",
    buildCommand: "",
    outputDirectory: "",
    startCommand: "node index.js",
    port: 3000,
    envVars: {},
  } as unknown as BuildConfig;
}

/** Every file in `dir`, as posix paths relative to it. */
async function listContext(dir: string): Promise<string[]> {
  const files: string[] = [];

  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) await walk(absolutePath);
      else files.push(relative(dir, absolutePath).split(sep).join("/"));
    }
  };

  await walk(dir);
  return files.sort();
}

async function contextFor(dockerignore: string): Promise<string[]> {
  const tree = await prepareSourceTree(config(await makeRepo(dockerignore)));
  cleanups.push(tree.cleanup);
  return listContext(tree.contextDir);
}

afterAll(async () => {
  await Promise.all(cleanups.map((fn) => fn().catch(() => {})));
});

describe("prepareSourceTree — .dockerignore pruning", () => {
  it("keeps the Dockerfile and .dockerignore when .dockerignore excludes them", async () => {
    const files = await contextFor("Dockerfile\n.dockerignore\n");

    expect(files).toContain("Dockerfile");
    expect(files).toContain(".dockerignore");
  });

  it("matches patterns from the context root instead of at every depth", async () => {
    const files = await contextFor("node_modules\nbuild\n");

    expect(files).toContain("app/build/page.tsx");
    expect(files).toContain("packages/ui/node_modules/left-pad/index.js");
    expect(files).not.toContain("build/artifact.txt");
    expect(files).not.toContain("node_modules/left-pad/index.js");
  });

  it("prunes at every depth for a globstar pattern", async () => {
    const files = await contextFor("**/node_modules\n");

    expect(files).not.toContain("node_modules/left-pad/index.js");
    expect(files).not.toContain("packages/ui/node_modules/left-pad/index.js");
    expect(files).toContain("app/build/page.tsx");
  });

  it("keeps a root-level negation in an allowlist .dockerignore", async () => {
    const files = await contextFor("*\n!package.json\n");

    expect(files).toEqual([".dockerignore", "Dockerfile", "package.json"]);
  });
});

describe("createDockerBuildContext", () => {
  it("resolves the repository Dockerfile when .dockerignore excludes it", async () => {
    const repo = await makeRepo("Dockerfile\n");
    const context = await createDockerBuildContext(config(repo), {
      requireRepositoryDockerfile: true,
    });
    cleanups.push(context.cleanup);

    expect(context.dockerfileName).toBe("Dockerfile");
    expect(context.usesRepositoryDockerfile).toBe(true);
    expect(context.contextEntries).not.toContain("Dockerfile.openship");
  });

  it("does not fall back to a generated Dockerfile when .dockerignore excludes the repository one", async () => {
    const repo = await makeRepo("Dockerfile\n");
    const context = await createDockerBuildContext(config(repo), {
      requireRepositoryDockerfile: false,
    });
    cleanups.push(context.cleanup);

    expect(context.dockerfileName).toBe("Dockerfile");
    expect(context.usesRepositoryDockerfile).toBe(true);
  });
});
