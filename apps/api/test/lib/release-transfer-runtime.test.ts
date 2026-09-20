import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, symlink, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyReleaseTransferScripts, START_TS } from "../../scripts/build-release";

const exec = promisify(execFile);
let directory: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openship-release-869-"));
  env = {
    PATH: process.env.PATH,
    HOME: directory,
    NODE_ENV: "test",
    PGLITE_DATA_DIR: "memory://",
    BETTER_AUTH_SECRET: "release-test-encryption-secret",
    INTERNAL_TOKEN: "release-test-internal-token-000000000000000000",
    OPENSHIP_PGLITE_ASSETS_DIR: join(directory, "wrong-cli-assets"),
  };
  await copyReleaseTransferScripts(directory);
  // Model the real flat source layout while reusing the installed workspace
  // dependencies. The copied entry scripts and their relative imports are real.
  await symlink(resolve(import.meta.dirname, "../../src"), join(directory, "api/src"), "dir");
  await symlink(
    resolve(import.meta.dirname, "../../../../packages/db/src"),
    join(directory, "packages/db/src"),
    "dir",
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function run(relative: string, args: string[] = []) {
  try {
    const result = await exec("bun", [join(directory, relative), ...args], {
      cwd: directory,
      env,
      timeout: 30_000,
    });
    return { code: 0, ...result };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return result;
  }
}

describe("source release transfer entry points (#869)", () => {
  it("runs packaged dump and restore against their own PGlite package despite stale CLI assets", async () => {
    const output = join(directory, "dump.json");
    const dumped = await run("packages/db/scripts/dump.ts", ["--out", output]);
    expect(dumped.code, dumped.stderr).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toHaveProperty("tables");
    const restored = await run("packages/db/scripts/restore.ts", [
      "--in",
      output,
      "--mode",
      "merge",
    ]);
    expect(restored.code, restored.stderr).toBe(0);
  }, 45_000);

  it("reaches import validation in the packaged layout, and rejects incomplete transfer arguments before opening storage", async () => {
    const input = join(directory, "invalid.osx");
    await writeFile(input, "{}");
    const invalid = await run("api/scripts/import-instance.ts", ["--in", input]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Not an Openship export file");
    expect(invalid.stderr).not.toMatch(/pglite.wasm|ASM_CONSTS/);
    const mode = await run("api/scripts/import-instance.ts", ["--in", input, "--mode", "typo"]);
    expect(mode.code).toBe(1);
    expect(mode.stderr).toContain("--mode must be wipe or merge");
    await writeFile(input, JSON.stringify({ secrets: {} }));
    const sealed = await run("api/scripts/import-instance.ts", ["--in", input]);
    expect(sealed.code).toBe(1);
    expect(sealed.stderr).toContain("OPENSHIP_IMPORT_PASSPHRASE is required");
  }, 45_000);

  it("keeps ordinary inherited settings but removes CLI WASM overrides from both supervised children", async () => {
    // Replace the source symlink with two small child programs, so this checks
    // the generated supervisor itself without binding application ports.
    await rm(join(directory, "api/src"));
    await mkdir(join(directory, "api/src"));
    await mkdir(join(directory, "dashboard/apps/dashboard"), { recursive: true });
    const child = (name: string) => `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(directory, name))}, JSON.stringify({ assets: process.env.OPENSHIP_PGLITE_ASSETS_DIR ?? null, ordinary: process.env.AUDIT_INHERITED, port: process.env.PORT }));
setInterval(() => {}, 1000);`;
    await writeFile(join(directory, "api/src/index.ts"), child("api.json"));
    await writeFile(
      join(directory, "dashboard/apps/dashboard/standalone-server.mjs"),
      child("dashboard.json"),
    );
    await writeFile(join(directory, "start.ts"), START_TS);
    const supervisor = spawn("bun", [join(directory, "start.ts")], {
      cwd: directory,
      env: { ...env, AUDIT_INHERITED: "kept" },
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("exit", () => resolve());
    });
    try {
      await vi.waitFor(
        async () => {
          expect(JSON.parse(await readFile(join(directory, "api.json"), "utf8"))).toEqual({
            assets: null,
            ordinary: "kept",
            port: "4000",
          });
          expect(JSON.parse(await readFile(join(directory, "dashboard.json"), "utf8"))).toEqual({
            assets: null,
            ordinary: "kept",
            port: "3000",
          });
        },
        { timeout: 10_000 },
      );
    } finally {
      supervisor.kill("SIGTERM");
      await exited;
    }
  }, 20_000);
});
