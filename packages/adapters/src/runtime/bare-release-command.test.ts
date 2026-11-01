import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BareRuntime } from "./bare";
import { sq } from "./build-pipeline";
import { LocalExecutor } from "../system/local-executor";
import type { CommandExecutor, DeployConfig } from "../types";

/**
 * A bare release command runs in the STAGED artifact directory — the tree
 * `deploy` is about to promote — with the deploy's env exported, so a migration
 * sees the code it is migrating for and resolves its DSN exactly as the app
 * will. It runs BEFORE anything is promoted or started, so a non-zero exit must
 * surface as a throw: that is what fails the deploy while the previous release
 * is still the one serving.
 */
function makeExecutor(result: { code: number; output: string }) {
  const commands: string[] = [];
  const executor = {
    exec: vi.fn(async () => ""),
    streamExec: vi.fn(async (command: string) => {
      commands.push(command);
      return result;
    }),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ""),
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as CommandExecutor;
  return { executor, commands };
}

/** imageRef = the staged build directory, which is what bare hands `deploy`. */
function config(overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    projectId: "proj_1",
    deploymentId: "dep_1",
    buildSessionId: "bs_1",
    imageRef: "/opt/openship/.builds/bs_1",
    environment: "production",
    port: 8000,
    envVars: { DATABASE_URL: "postgres://u:p@db/app", "not-an-ident": "x" },
    resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
    ...overrides,
  } as unknown as DeployConfig;
}

describe("BareRuntime.runReleaseCommand", () => {
  it("migrates the shared persistent data on successive releases", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "openship-release-data-"));
    try {
      const runtime = new BareRuntime({ workDir, executor: new LocalExecutor() });
      for (const release of ["first", "second"]) {
        const imageRef = join(workDir, ".builds", release);
        await mkdir(join(imageRef, "storage"), { recursive: true });
        await writeFile(join(imageRef, "storage", "schema"), "seed");
        await runtime.runReleaseCommand(
          config({ imageRef, volumes: ["storage:/app/storage"] }),
          "printf ':migrated' >> storage/schema",
          () => {},
        );
      }
      expect(await readFile(join(workDir, "shared", "proj_1", "storage", "schema"), "utf8"))
        .toBe("seed:migrated:migrated");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it.each([0, 1])("never modifies a retained release's application files, even on exit %i", async exitCode => {
    const workDir = await mkdtemp(join(tmpdir(), "openship-release-retained-"));
    try {
      const imageRef = join(workDir, "releases", "live");
      const storage = join(workDir, "shared", "proj_1", "storage");
      await mkdir(imageRef, { recursive: true });
      await mkdir(storage, { recursive: true });
      await symlink(storage, join(imageRef, "storage"));
      await writeFile(join(storage, "schema"), "seed");
      await writeFile(join(imageRef, "app.js"), "original app");
      const result = new BareRuntime({ workDir, executor: new LocalExecutor() }).runReleaseCommand(
        config({ imageRef, volumes: ["storage:/app/storage"] }),
        `printf changed > app.js; printf ':migrated' >> storage/schema; exit ${exitCode}`, () => {},
      );
      if (exitCode) await expect(result).rejects.toThrow("exit code 1");
      else await result;
      expect(await readFile(join(imageRef, "app.js"), "utf8")).toBe("original app");
      expect(await readFile(join(storage, "schema"), "utf8")).toBe("seed:migrated");
      expect(await readdir(join(workDir, ".builds"))).toEqual([]);
    } finally { await rm(workDir, { recursive: true, force: true }); }
  });

  it("does not execute against disposable data when persistence preparation fails", async () => {
    const { executor } = makeExecutor({ code: 0, output: "" });
    vi.mocked(executor.mkdir).mockRejectedValueOnce(new Error("Permission denied"));
    await expect(new BareRuntime({ executor }).runReleaseCommand(
      config({ volumes: ["storage:/app/storage"] }), "migrate", () => {},
    )).rejects.toThrow(/Could not persist storage.*Permission denied/);
    expect(executor.streamExec).not.toHaveBeenCalled();
  });

  it("refuses to run without the candidate artifact", async () => {
    const { executor } = makeExecutor({ code: 0, output: "" });
    await expect(new BareRuntime({ executor }).runReleaseCommand(
      config({ imageRef: undefined }), "migrate", () => {},
    )).rejects.toThrow(/staged build artifact/);
    expect(executor.streamExec).not.toHaveBeenCalled();
  });

  it("reaps a local grandchild before acknowledging cancellation", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "openship-release-cancel-"));
    const abort = new AbortController();
    let pid: number | undefined;
    try {
      const pidFile = join(workDir, "child.pid");
      const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      const command = `${sq(process.execPath)} -e ${sq(script)} > /dev/null 2>&1 & ` +
        `while [ ! -f ${sq(pidFile)} ]; do sleep 0.01; done; printf ready; wait`;
      await expect(new BareRuntime({ workDir, executor: new LocalExecutor() }).runReleaseCommand(
        config({ imageRef: workDir }), command,
        entry => { if (entry.message.includes("ready")) abort.abort(new Error("User cancelled")); },
        { signal: abort.signal, timeoutMs: 5_000 },
      )).rejects.toThrow("User cancelled");
      pid = Number(await readFile(pidFile, "utf8"));
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 2_000 });
    } finally {
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await rm(workDir, { recursive: true, force: true });
    }
  });

  // Same env as the supervised app, by construction (bareProcessEnv). On bare a
  // project PATH is worse than on docker: `export PATH=…` REPLACES the base, so
  // even `/usr/bin/env node` stops resolving.
  it("does not export a project-set PATH, exactly as deploy does, and says so", async () => {
    const { executor, commands } = makeExecutor({ code: 0, output: "" });
    const lines: Array<{ message: string; level?: string }> = [];
    await new BareRuntime({ executor }).runReleaseCommand(
      config({ envVars: { DATABASE_URL: "postgres://u:p@db/app", PATH: "/copied/from/heroku" } }),
      "php artisan migrate --force",
      (entry) => lines.push(entry),
    );
    expect(commands[0]).not.toContain("/copied/from/heroku");
    expect(commands[0]).toContain("export DATABASE_URL='postgres://u:p@db/app'");
    expect(lines.some((line) => line.level === "warn" && line.message.includes("PATH"))).toBe(true);
  });

  // `prisma migrate deploy` names a node_modules/.bin binary exactly the way
  // `next start` does; the start command gets that dir prepended (openship#623),
  // so the release command has to as well, or it exits 127 where the app runs.
  it("puts node_modules/.bin on PATH for a Node package manager, as the start command gets", async () => {
    const { executor, commands } = makeExecutor({ code: 0, output: "" });
    await new BareRuntime({ executor }).runReleaseCommand(
      config({ packageManager: "npm" } as Partial<DeployConfig>),
      "prisma migrate deploy",
      () => {},
    );
    expect(commands[0]).toMatch(
      /cd '\/opt\/openship\/\.builds\/bs_1' && export PATH='\/opt\/openship\/\.builds\/bs_1\/node_modules\/\.bin':"\$PATH" && prisma migrate deploy/,
    );
  });

  it("declares the capability", () => {
    expect(new BareRuntime({ executor: makeExecutor({ code: 0, output: "" }).executor }).supports("releaseCommand")).toBe(true);
  });

  it("runs in the staged release dir with the start command's env", async () => {
    const { executor, commands } = makeExecutor({ code: 0, output: "" });
    const runtime = new BareRuntime({ executor });
    await runtime.runReleaseCommand(config(), "php artisan migrate --force", () => {});

    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command).toContain("cd '/opt/openship/.builds/bs_1' && php artisan migrate --force");
    expect(command).toContain("export DATABASE_URL='postgres://u:p@db/app'");
    // PORT/NODE_ENV are part of the start command's env, so they're part of this one.
    expect(command).toContain("export PORT='8000'");
    expect(command).toContain("export NODE_ENV='production'");
    // A key that isn't a shell identifier would break the export prefix outright.
    expect(command).not.toContain("not-an-ident");
  });

  // The whole gate: without this throw a failed migration deploys anyway.
  it("throws with the command's own output when it exits non-zero", async () => {
    const { executor } = makeExecutor({ code: 1, output: "SQLSTATE[42S02]: table not found" });
    const runtime = new BareRuntime({ executor });
    await expect(
      runtime.runReleaseCommand(config(), "php artisan migrate --force", () => {}),
    ).rejects.toThrow(/exit code 1[\s\S]*SQLSTATE\[42S02\]/);
  });

  // Bounded: an unbounded release command holds the deploy open forever with the
  // old version still serving. The abort's exit code must not be reported as the
  // failure — the timeout is the story.
  it("aborts and reports a timeout rather than the killed child's exit code", async () => {
    const executor = {
      exec: vi.fn(async () => ""),
      streamExec: vi.fn(
        (_command: string, _onLog: unknown, opts?: { signal?: AbortSignal }) =>
          new Promise<{ code: number; output: string }>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve({ code: 143, output: "" }));
          }),
      ),
      writeFile: vi.fn(async () => {}),
      readFile: vi.fn(async () => ""),
      exists: vi.fn(async () => false),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as CommandExecutor;
    const runtime = new BareRuntime({ executor });
    await expect(
      runtime.runReleaseCommand(config(), "sleep 999", () => {}, { timeoutMs: 20 }),
    ).rejects.toThrow(/timed out after/);
  });
});
