import { describe, expect, it, vi } from "vitest";
import { BareRuntime } from "./bare";
import type { CommandExecutor, DeployConfig } from "../types";

/**
 * Bare has no volume to mount, so persistence is the deploy convention instead:
 * keep the stateful paths in `shared/` and symlink them into each release. Without
 * it a redeploy replaces the release directory and takes the app's uploads,
 * sessions and cache with it — the same silent data loss a missing Docker volume
 * causes, on the runtime the desktop app uses by default.
 */

function makeExecutor(paths: string[] = []) {
  const existing = new Set(paths);
  const calls: string[] = [];
  const removed: string[] = [];
  const made: string[] = [];
  const exec = vi.fn(async (command: string) => {
    calls.push(command);
    return "";
  });
  const executor = {
    exec,
    streamExec: vi.fn(async () => ({ code: 0, output: "" })),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ""),
    exists: vi.fn(async (p: string) => existing.has(p)),
    mkdir: vi.fn(async (p: string) => {
      made.push(p);
    }),
    rm: vi.fn(async (p: string) => {
      removed.push(p);
    }),
    transferIn: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as CommandExecutor;
  return { executor, calls, removed, made };
}

/** No imageRef → workDir === the project dir, so no artifact promotion runs. */
function config(volumes: string[]): DeployConfig {
  return {
    projectId: "proj_1",
    deploymentId: "dep_1",
    environment: "production",
    port: 8000,
    envVars: {},
    startCommand: "true",
    volumes,
  } as unknown as DeployConfig;
}

const WORK = "/opt/openship";
const RELEASE = `${WORK}/proj_1`;
const SHARED = `${WORK}/shared/proj_1`;

/**
 * The linking happens BEFORE the supervisor starts the process (an app can open a
 * file under one of these paths on boot). The fake executor can't satisfy the
 * supervisor, so its failure is swallowed — every assertion below is about work
 * that already happened by then.
 */
async function deploy(rt: BareRuntime, cfg: DeployConfig) {
  await rt.deploy(cfg).catch(() => {});
}

describe("BareRuntime persistent paths", () => {
  it("seeds shared/ from the release the first time, then symlinks the path in", async () => {
    // The release ships a storage/ skeleton; shared/ doesn't exist yet.
    const { executor, calls, removed } = makeExecutor([`${RELEASE}/storage`]);
    const rt = new BareRuntime({ workDir: WORK, executor });

    await deploy(rt, config([`storage:/app/storage`]));

    expect(calls.some((c) => c.includes(`cp -a '${RELEASE}/storage' '${SHARED}/storage'`))).toBe(
      true,
    );
    expect(removed).toContain(`${RELEASE}/storage`);
    expect(calls.some((c) => c === `ln -sfn '${SHARED}/storage' '${RELEASE}/storage'`)).toBe(true);
  });

  it("does NOT re-seed when shared/ already has the data (that would overwrite it)", async () => {
    const { executor, calls } = makeExecutor([`${RELEASE}/storage`, `${SHARED}/storage`]);
    const rt = new BareRuntime({ workDir: WORK, executor });

    await deploy(rt, config([`storage:/app/storage`]));

    expect(calls.some((c) => c.startsWith("cp -a"))).toBe(false);
    // -n, so the existing symlink is replaced instead of being followed into
    // (which would nest shared/storage/storage on the second deploy).
    expect(calls.some((c) => c === `ln -sfn '${SHARED}/storage' '${RELEASE}/storage'`)).toBe(true);
  });

  it("creates the shared path when the release doesn't ship one", async () => {
    const { executor, made, calls } = makeExecutor();
    const rt = new BareRuntime({ workDir: WORK, executor });

    await deploy(rt, config(["uploads:/app/uploads"]));

    expect(made).toContain(`${SHARED}/uploads`);
    expect(calls.some((c) => c.startsWith("cp -a"))).toBe(false);
  });

  it("ignores mounts that aren't inside the app dir — bare has nothing to link", async () => {
    const { executor, calls } = makeExecutor();
    const rt = new BareRuntime({ workDir: WORK, executor });

    await deploy(rt, config(["pgdata:/var/lib/postgresql/data"]));

    expect(calls.some((c) => c.startsWith("ln -sfn"))).toBe(false);
  });

  it("touches nothing when no volumes are declared", async () => {
    const { executor, calls, removed } = makeExecutor();
    const rt = new BareRuntime({ workDir: WORK, executor });

    await deploy(rt, config([]));

    expect(calls.some((c) => c.startsWith("ln -sfn"))).toBe(false);
    expect(removed).toHaveLength(0);
  });

  it("keeps the adopt path clear of it (no release tree to link into)", async () => {
    const { executor, calls } = makeExecutor();
    const rt = new BareRuntime({ workDir: WORK, executor });

    await deploy(rt, { ...config(["storage:/app/storage"]), adopt: true } as DeployConfig);

    expect(calls.some((c) => c.startsWith("ln -sfn"))).toBe(false);
  });
});
