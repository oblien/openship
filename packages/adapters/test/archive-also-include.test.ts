import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getTarCreateEnv, prepareSourceTarArgs } from "../src/archive";

const exec = promisify(execFile);

/**
 * Regression coverage for the build-output shipping bug: a locally-built app's
 * `.next` is gitignored, so packing the git clone via git-truth
 * (`git ls-files --exclude-standard`) drops it and the target has no build.
 * `alsoInclude` must re-add the build output — while gitignored secrets and
 * deps stay out.
 */

let repo: string;
const cleanups: string[] = [];

/** Pack `repo` with the given options and return the archive's entry paths. */
async function listArchive(opts?: Parameters<typeof prepareSourceTarArgs>[1]): Promise<string[]> {
  const { args, cleanup } = await prepareSourceTarArgs(repo, opts);
  try {
    const { stdout } = await exec("tar", args, {
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
      env: getTarCreateEnv(),
    });
    const dir = await mkdtemp(join(tmpdir(), "arch-out-"));
    cleanups.push(dir);
    const tgz = join(dir, "ctx.tgz");
    await writeFile(tgz, stdout as Buffer);
    const { stdout: listing } = await exec("tar", ["-tzf", tgz], { maxBuffer: 64 * 1024 * 1024 });
    return listing
      .split("\n")
      .map((s) => s.replace(/^\.\//, "").replace(/\/$/, ""))
      .filter(Boolean);
  } finally {
    await cleanup();
  }
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "repo-"));
  cleanups.push(repo);
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await exec("git", ["-C", repo, "config", "commit.gpgsign", "false"]);

  // Tracked source.
  await writeFile(join(repo, "package.json"), '{"name":"dr","version":"0.1.0"}');
  await writeFile(join(repo, "index.js"), "console.log('hi')");
  await writeFile(join(repo, ".gitignore"), ".next\n.env\nnode_modules\n");

  // Gitignored build output (must ship via alsoInclude).
  await mkdir(join(repo, ".next", "server"), { recursive: true });
  await writeFile(join(repo, ".next", "BUILD_ID"), "abc123");
  await writeFile(join(repo, ".next", "server", "app.js"), "module.exports={}");

  // Gitignored secret + deps (must NOT ship).
  await writeFile(join(repo, ".env"), "SECRET=leak");
  await mkdir(join(repo, "node_modules", "foo"), { recursive: true });
  await writeFile(join(repo, "node_modules", "foo", "index.js"), "0");

  await exec("git", ["-C", repo, "add", "-A"]);
  await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);
});

afterAll(async () => {
  await Promise.all(cleanups.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

describe("prepareSourceTarArgs alsoInclude (git-truth branch)", () => {
  it("git-truth alone drops the gitignored build output (reproduces the bug)", async () => {
    const files = await listArchive();
    expect(files).toContain("package.json");
    expect(files).toContain("index.js");
    expect(files).not.toContain(".next/BUILD_ID"); // gitignored → dropped
    expect(files).not.toContain(".env");
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
  });

  it("alsoInclude re-adds the build output, still excludes secrets + deps", async () => {
    const files = await listArchive({ alsoInclude: [".next"] });
    expect(files).toContain("package.json"); // tracked source kept
    expect(files).toContain("index.js");
    expect(files).toContain(".next/BUILD_ID"); // build output now shipped
    expect(files).toContain(".next/server/app.js");
    expect(files).not.toContain(".env"); // gitignored secret still dropped
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
  });

  it("skips a non-existent alsoInclude path without aborting the pack", async () => {
    const files = await listArchive({ alsoInclude: ["dist", ".next"] }); // no dist here
    expect(files).toContain("package.json");
    expect(files).toContain(".next/BUILD_ID");
  });

  it("packs a dirty worktree with unstaged deletions and keeps untracked source", async () => {
    const deleted = "removed file.js";
    await writeFile(join(repo, deleted), "old source");
    await exec("git", ["-C", repo, "add", "--", deleted]);
    await rm(join(repo, deleted));
    await writeFile(join(repo, "new file.js"), "new source");
    const files = await listArchive();
    expect(files).not.toContain(deleted);
    expect(files).toContain("new file.js");
    expect(files).toContain("index.js");
    expect(files).not.toContain(".env");
  });
});
