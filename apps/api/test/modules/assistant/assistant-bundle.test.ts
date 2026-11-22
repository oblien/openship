import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "tsup";
import { it } from "vitest";

const exec = promisify(execFile);
const apiDir = resolve(import.meta.dirname, "../../..");

it("discovers agent models after the bundled assistant and app initialize", async () => {
  // Keep the compiled program under the API workspace for external imports.
  const outDir = await mkdtemp(join(apiDir, ".assistant-bundle-"));
  try {
    await build({
      entry: [join(import.meta.dirname, "fixtures/bundled-model-discovery.ts")],
      outDir,
      format: ["esm"],
      silent: true,
    });
    await exec(process.execPath, ["--import", "tsx", join(outDir, "bundled-model-discovery.js")], {
      cwd: apiDir,
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DEPLOY_MODE: "docker",
        INTERNAL_TOKEN: "assistant-bundle-test-internal-token-0123456789",
        OPENSHIP_AUTH_MODE: "local",
        OPENSHIP_DATA_DIR: outDir,
        OPENSHIP_LOCAL_DASHBOARD_URL: "http://localhost:3001",
        OPENSHIP_CACHE_STORE: "memory",
        OPENSHIP_RATE_LIMIT_STORE: "memory",
        OPENSHIP_JOB_RUNNER: "in-process",
        BETTER_AUTH_SECRET: "assistant-bundle-test-secret-0123456789",
      },
    });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}, 60_000);
