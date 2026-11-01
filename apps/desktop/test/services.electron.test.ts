import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("boots and reloads native Electron service processes without changing the Desktop profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openship-electron-services-"));
  try {
    const entry = join(directory, "test.cjs");
    await build({
      entryPoints: [fileURLToPath(new URL("./fixtures/services.electron.ts", import.meta.url))],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      logLevel: "silent",
    });
    const electron = createRequire(import.meta.url)("electron") as string;
    const version = createRequire(import.meta.url)("electron/package.json").version as string;
    const headless = process.platform === "linux" && !process.env.DISPLAY;
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [
      "--disable-gpu",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      entry,
      `--fixture-dir=${directory}`,
      `--expected-electron=${version}`,
    ];
    const result = await promisify(execFile)(
      headless ? "xvfb-run" : electron,
      headless ? ["-a", electron, ...args] : args,
      { env, timeout: 35_000, maxBuffer: 1024 * 1024 },
    ).catch((error) => {
      throw new Error(
        `Electron service process regression failed\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
        { cause: error },
      );
    });
    expect(result.stdout, result.stderr).toContain("Electron service processes passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
