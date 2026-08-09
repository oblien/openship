import { describe, expect, it, vi } from "vitest";
import { BareRuntime } from "./bare";
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
function config(): DeployConfig {
  return {
    projectId: "proj_1",
    deploymentId: "dep_1",
    buildSessionId: "bs_1",
    imageRef: "/opt/openship/.builds/bs_1",
    environment: "production",
    port: 8000,
    envVars: { DATABASE_URL: "postgres://u:p@db/app", "not-an-ident": "x" },
    resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
  } as unknown as DeployConfig;
}

describe("BareRuntime.runReleaseCommand", () => {
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
