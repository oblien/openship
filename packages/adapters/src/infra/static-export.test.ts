import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { staticExportCopyCommand } from "./static-export";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("publishes private-mode build artifacts as readable assets without changing the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "openship-static-modes-"));
  roots.push(root);
  const source = join(root, "source");
  const staging = join(root, "public");
  await mkdir(join(source, "assets"), { recursive: true });
  const asset = join(source, "assets/app.js");
  await writeFile(asset, "export const ready = true;");
  await chmod(join(source, "assets"), 0o700);
  await chmod(asset, 0o600);
  await run("sh", ["-ec", staticExportCopyCommand(source, staging)]);
  expect(await readFile(join(staging, "assets/app.js"), "utf8")).toContain("ready = true");
  expect((await stat(join(staging, "assets"))).mode & 0o777).toBe(0o755);
  expect((await stat(join(staging, "assets/app.js"))).mode & 0o777).toBe(0o644);
  expect((await stat(join(source, "assets"))).mode & 0o777).toBe(0o700);
  expect((await stat(asset)).mode & 0o777).toBe(0o600);
});

it("refuses symlinks in the staged export without changing their target", async () => {
  const root = await mkdtemp(join(tmpdir(), "openship-static-symlink-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  const secret = join(root, "private");
  await writeFile(secret, "private", { mode: 0o600 });
  await symlink(secret, join(source, "leak"));
  await expect(
    run("sh", ["-ec", staticExportCopyCommand(source, join(root, "public"))]),
  ).rejects.toThrow();
  expect((await stat(secret)).mode & 0o777).toBe(0o600);
});
