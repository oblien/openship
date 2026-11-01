import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BareRuntime } from "./bare";
import { LocalExecutor } from "../system/executor";
import type { BuildConfig } from "../types";

vi.mock("../toolchain", () => ({
  checkToolchainForStack: async () => ({ ready: true }),
  installTools: vi.fn(),
}));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function build(stack: string, startCommand: string) {
  const workDir = await mkdtemp(join(tmpdir(), "openship-bare-start-"));
  directories.push(workDir);
  const runtime = new BareRuntime({
    workDir,
    executor: new LocalExecutor(),
    prepareSource: async (_config, directory) => {
      const app = join(directory, "apps/web");
      await mkdir(join(app, ".next/standalone"), { recursive: true });
      await writeFile(join(app, "server.js"), "console.log('custom-start');");
      await writeFile(join(app, ".next/standalone/server.js"), "console.log('automatic-start');");
      return true;
    },
  });
  const result = await runtime.build({
    projectId: "project",
    sessionId: "session",
    stack,
    packageManager: "npm",
    rootDirectory: "apps/web",
    startCommand,
    installCommand: "",
    buildCommand: "",
    envVars: {},
  } as BuildConfig);
  expect(result.status).toBe("deploying");
  return execFileSync("sh", ["-c", result.startCommand ?? startCommand], {
    cwd: result.imageRef,
    encoding: "utf8",
  }).trim();
}

describe("direct-server start command compatibility", () => {
  it.each(["nextjs", "django"])(
    "preserves explicit %s commands relative to the repository",
    async (stack) => {
      expect(await build(stack, "cd apps/web && node server.js")).toBe("custom-start");
    },
  );
  it("runs the managed Next.js default from the application directory using standalone output", async () => {
    expect(await build("nextjs", "next start")).toBe("automatic-start");
  });
});
