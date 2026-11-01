import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build, type BuildOptions } from "esbuild";
import { expect, it } from "vitest";
import { desktopBuildOptions } from "../build/options.mjs";

it("renders the offline startup screen with the packaged CSS loader and shared palettes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openship-electron-loading-"));
  try {
    const entry = join(directory, "test.cjs");
    const production = desktopBuildOptions.find((options: { outfile: string }) =>
      options.outfile.includes("/main/"),
    );
    await build({
      ...production,
      entryPoints: [
        fileURLToPath(new URL("./fixtures/loading-screen.electron.ts", import.meta.url)),
      ],
      outfile: entry,
      logLevel: "silent",
    } as BuildOptions);
    const electron = createRequire(import.meta.url)("electron") as string;
    const headless = process.platform === "linux" && !process.env.DISPLAY;
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete env.ELECTRON_RUN_AS_NODE;
    // Run only the splash in a disposable profile; never start the user's
    // controller, open its database or register an OS protocol handler.
    const args = [
      "--disable-gpu",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      entry,
      `--fixture-dir=${directory}`,
    ];
    const result = await promisify(execFile)(
      headless ? "xvfb-run" : electron,
      headless ? ["-a", electron, ...args] : args,
      { env, timeout: 30_000, maxBuffer: 1024 * 1024 },
    ).catch((error) => {
      throw new Error(
        `Electron loading screen test failed\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
        { cause: error },
      );
    });
    expect(result.stdout, result.stderr).toContain("Electron loading screen passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
