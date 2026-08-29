import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import type { BuildConfig } from "../types";

import {
  createDockerBuildContext,
  prepareSourceTree,
  resolveServiceDockerfile,
} from "./docker-build-context";

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

/**
 * #634. A compose service declares `build: <dir>` — a build CONTEXT. The runtime
 * resolved its Dockerfile at `<dir>/Dockerfile` but kept the CLONE ROOT as the
 * context, so the service's own `COPY requirements.txt` looked for the file at the
 * repo root and the repo's root `.dockerignore` decided what its build could see.
 *
 * `svc/` below is a self-contained service directory, the shape every normal compose
 * sub-service has: its own Dockerfile, its own files, its own `.dockerignore`.
 */
async function makeServiceRepo(opts: {
  rootDockerignore?: string;
  serviceDockerignore?: string;
  serviceDockerfile?: string;
  serviceDockerfileName?: string;
  omitServiceDockerfile?: boolean;
  symlinkedContext?: boolean;
}): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "dbc-svc-"));
  cleanups.push(() => rm(repo, { recursive: true, force: true }));

  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await exec("git", ["-C", repo, "config", "commit.gpgsign", "false"]);

  if (opts.rootDockerignore !== undefined) {
    await writeFile(join(repo, ".dockerignore"), opts.rootDockerignore);
  }
  // A ROOT Dockerfile that must never be built under the service's tag.
  await writeFile(join(repo, "Dockerfile"), "FROM node:22\nRUN echo wrong-image\n");
  await writeFile(join(repo, "package.json"), '{"name":"root","version":"0.1.0"}');

  await mkdir(join(repo, "svc"), { recursive: true });
  if (!opts.omitServiceDockerfile) {
    await writeFile(
      join(repo, "svc", opts.serviceDockerfileName ?? "Dockerfile"),
      opts.serviceDockerfile ?? "FROM python:3.12\nCOPY requirements.txt /app/\n",
    );
  }
  await writeFile(join(repo, "svc", "requirements.txt"), "flask\n");
  await writeFile(join(repo, "svc", "app.py"), "print('hi')\n");
  await mkdir(join(repo, "svc", "secrets"), { recursive: true });
  await writeFile(join(repo, "svc", "secrets", "key.pem"), "SECRET\n");
  if (opts.serviceDockerignore !== undefined) {
    await writeFile(join(repo, "svc", ".dockerignore"), opts.serviceDockerignore);
  }

  if (opts.symlinkedContext) {
    await symlink(tmpdir(), join(repo, "escape"));
  }

  await exec("git", ["-C", repo, "add", "-A", "-f"]);
  await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);

  return repo;
}

function serviceConfig(localPath: string, overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    ...config(localPath),
    stack: "docker",
    rootDirectory: "svc",
    buildContextDirectory: "svc",
    dockerfilePath: "Dockerfile",
    ...overrides,
  } as BuildConfig;
}

describe("declared build context (#634)", () => {
  it("points the build at the service directory, with a context-relative Dockerfile", async () => {
    const repo = await makeServiceRepo({});
    const context = await createDockerBuildContext(serviceConfig(repo), {
      requireRepositoryDockerfile: true,
    });
    cleanups.push(context.cleanup);

    expect(context.contextSubdir).toBe("svc");
    expect(context.buildContextDir).toBe(join(context.contextDir, "svc"));
    // Relative to the CONTEXT — what `docker build -f` and dockerode's `dockerfile`
    // both want. A tree-relative "svc/Dockerfile" would miss once the cwd is `svc`.
    expect(context.dockerfileName).toBe("Dockerfile");
    expect(context.usesRepositoryDockerfile).toBe(true);
    // The files the service's own COPY refers to are the top level of the context.
    expect(context.contextEntries.sort()).toEqual([
      "Dockerfile",
      "app.py",
      "requirements.txt",
      "secrets",
    ]);
    // The tree itself is still whole — it is the transfer/cleanup unit, shared by
    // every service in a compose batch.
    expect(await readdir(context.contextDir)).toContain("package.json");
  });

  it("never builds the source-root Dockerfile under the service's tag", async () => {
    const repo = await makeServiceRepo({ omitServiceDockerfile: true });

    await expect(
      createDockerBuildContext(serviceConfig(repo), { requireRepositoryDockerfile: true }),
    ).rejects.toThrow(/No Dockerfile found in the build context "svc"/);
  });

  it("refuses to generate a recipe for a declared context", async () => {
    // A generated recipe COPYs from the source root, so it cannot be satisfied by a
    // narrowed context — failing here beats failing mid-build with a missing COPY.
    const repo = await makeServiceRepo({ omitServiceDockerfile: true });

    await expect(
      createDockerBuildContext(serviceConfig(repo), { requireRepositoryDockerfile: false }),
    ).rejects.toThrow(/will not generate one/);
  });

  it("resolves a dockerfile that still carries the context prefix", async () => {
    const repo = await makeServiceRepo({ serviceDockerfileName: "Dockerfile.prod" });
    const context = await createDockerBuildContext(
      serviceConfig(repo, { dockerfilePath: "svc/Dockerfile.prod" }),
      { requireRepositoryDockerfile: true },
    );
    cleanups.push(context.cleanup);

    expect(context.dockerfileName).toBe("Dockerfile.prod");
  });

  it("refuses a context that escapes the tree through a symlink", async () => {
    const repo = await makeServiceRepo({ symlinkedContext: true });

    await expect(
      createDockerBuildContext(
        serviceConfig(repo, { rootDirectory: "escape", buildContextDirectory: "escape" }),
        { requireRepositoryDockerfile: true },
      ),
    ).rejects.toThrow(/resolves outside the source tree/);
  });

  it("refuses a context that is not a directory", async () => {
    const repo = await makeServiceRepo({});

    await expect(
      createDockerBuildContext(
        serviceConfig(repo, { rootDirectory: "package.json", buildContextDirectory: "package.json" }),
        { requireRepositoryDockerfile: true },
      ),
    ).rejects.toThrow(/is not a directory/);
  });

  it("refuses a traversing context", async () => {
    const repo = await makeServiceRepo({});

    await expect(
      createDockerBuildContext(serviceConfig(repo, { buildContextDirectory: "../.." }), {
        requireRepositoryDockerfile: true,
      }),
    ).rejects.toThrow(/must not contain/);
  });
});

describe("declared build context — .dockerignore ownership (#634)", () => {
  it("does not let the source root's .dockerignore prune the service's tree", async () => {
    // The pathological-but-real case: an allowlist root `.dockerignore` written for
    // the ROOT app. Pruning the shared tree with it used to empty every sub-service
    // context, so the service's own COPY could not find a single file.
    const repo = await makeServiceRepo({ rootDockerignore: "*\n!package.json\n" });
    const context = await createDockerBuildContext(serviceConfig(repo), {
      requireRepositoryDockerfile: true,
    });
    cleanups.push(context.cleanup);

    expect(context.contextEntries.sort()).toEqual([
      "Dockerfile",
      "app.py",
      "requirements.txt",
      "secrets",
    ]);
    expect(await listContext(context.buildContextDir)).toContain("requirements.txt");
  });

  it("applies the service's OWN .dockerignore, anchored at the service dir", async () => {
    const repo = await makeServiceRepo({ serviceDockerignore: "secrets\napp.py\n" });
    const context = await createDockerBuildContext(serviceConfig(repo), {
      requireRepositoryDockerfile: true,
    });
    cleanups.push(context.cleanup);

    // The tree is NOT pruned destructively (it is shared), so the filter is handed
    // to the packer instead — both halves have to agree or the tar goes out wrong.
    expect(context.contextEntries.sort()).toEqual([".dockerignore", "Dockerfile", "requirements.txt"]);
    expect(context.ignoreContextPath?.("secrets")).toBe(true);
    expect(context.ignoreContextPath?.("secrets/key.pem")).toBe(true);
    expect(context.ignoreContextPath?.("requirements.txt")).toBe(false);
    // Sent to the builder regardless of what the file says — the daemon reads the
    // Dockerfile out of the tar we pack.
    expect(context.ignoreContextPath?.("Dockerfile")).toBe(false);
    // Still on disk: pruning the shared tree is what we stopped doing.
    expect(await listContext(context.buildContextDir)).toContain("secrets/key.pem");
  });

  it("keeps the service's own Dockerfile even when its .dockerignore excludes it", async () => {
    const repo = await makeServiceRepo({ serviceDockerignore: "Dockerfile\n.dockerignore\n" });
    const context = await createDockerBuildContext(serviceConfig(repo), {
      requireRepositoryDockerfile: true,
    });
    cleanups.push(context.cleanup);

    expect(context.contextEntries).toContain("Dockerfile");
    expect(context.ignoreContextPath?.("Dockerfile")).toBe(false);
    expect(context.ignoreContextPath?.(".dockerignore")).toBe(false);
  });

  it("still prunes destructively for a whole-tree context", async () => {
    // The unchanged path: no declared context ⇒ the tree IS the context, so the
    // prune stays (it also shrinks the SSH transfer) and no filter is handed back.
    const tree = await prepareSourceTree(config(await makeRepo("node_modules\n")));
    cleanups.push(tree.cleanup);

    expect(tree.dockerignorePruned).toBe(true);
    expect(await listContext(tree.contextDir)).not.toContain("node_modules/left-pad/index.js");
  });

  it("defers the prune once any service in the batch declares a context", async () => {
    const repo = await makeServiceRepo({ rootDockerignore: "svc\n" });
    const tree = await prepareSourceTree(config(repo), { perServiceBuildContexts: true });
    cleanups.push(tree.cleanup);

    expect(tree.dockerignorePruned).toBe(false);
    // `svc` would have been deleted outright by the root .dockerignore.
    expect(await listContext(tree.contextDir)).toContain("svc/requirements.txt");

    const resolved = await resolveServiceDockerfile(tree.contextDir, serviceConfig(repo), {
      requireRepositoryDockerfile: true,
      dockerignorePruned: tree.dockerignorePruned,
    });
    expect(resolved.dockerfileName).toBe("Dockerfile");
    // The service dir has no .dockerignore of its own, so there is nothing to filter.
    expect(resolved.ignoreContextPath).toBeUndefined();
  });
});

describe("BuildKit-only Dockerfile detection", () => {
  it("flags a Dockerfile the classic builder cannot build", async () => {
    const repo = await makeServiceRepo({
      serviceDockerfile:
        "FROM python:3.12\nRUN --mount=type=cache,target=/root/.cache pip install -r requirements.txt\n",
    });
    const context = await createDockerBuildContext(serviceConfig(repo), {
      requireRepositoryDockerfile: true,
    });
    cleanups.push(context.cleanup);

    expect(context.requiresBuildKit).toBe(true);
  });

  it("leaves a plain Dockerfile on the default builder", async () => {
    const repo = await makeServiceRepo({});
    const context = await createDockerBuildContext(serviceConfig(repo), {
      requireRepositoryDockerfile: true,
    });
    cleanups.push(context.cleanup);

    expect(context.requiresBuildKit).toBe(false);
  });
});
