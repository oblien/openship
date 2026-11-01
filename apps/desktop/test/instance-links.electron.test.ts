import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { desktopInstanceLink } from "@repo/core";

it("delivers cold and second-process invitations in real Electron without starting another controller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openship-electron-links-"));
  try {
    const entry = join(directory, "test.cjs");
    await build({
      entryPoints: [
        fileURLToPath(new URL("./fixtures/instance-links.electron.ts", import.meta.url)),
      ],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      logLevel: "silent",
    });
    const electron = createRequire(import.meta.url)("electron") as string;
    const headless = process.platform === "linux" && !process.env.DISPLAY;
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete env.ELECTRON_RUN_AS_NODE;
    // This fixture opens no renderer, uses fresh userData and never registers
    // the OS scheme or starts the production API, workers or dashboard.
    const args = [
      // Keep a switch before the entry on every OS: Electron retains switches
      // in process.argv, so the second launch must not assume argv[1] is a file.
      "--disable-gpu",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      entry,
      `--fixture-dir=${directory}`,
      desktopInstanceLink("https://cold.example.test/accept-invite/inv_cold"),
    ];
    const result = await promisify(execFile)(
      headless ? "xvfb-run" : electron,
      headless ? ["-a", electron, ...args] : args,
      { env, timeout: 25_000, maxBuffer: 1024 * 1024 },
    ).catch((error) => {
      throw new Error(
        `Electron instance-link test failed\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
        { cause: error },
      );
    });
    expect(result.stdout).toContain("Electron instance links passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 35_000);
