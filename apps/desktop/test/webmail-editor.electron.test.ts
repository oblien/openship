import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { editorSharedPackages } from "../../email/client/lib/editor-dependencies";

it("edits mail with the real Novel extensions and production ProseMirror deduplication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openship-mail-editor-"));
  try {
    const entry = join(directory, "test.cjs");
    await build({
      entryPoints: [
        fileURLToPath(new URL("./fixtures/webmail-editor.electron.ts", import.meta.url)),
      ],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      logLevel: "silent",
    });
    const client = createRequire(new URL("../../email/client/package.json", import.meta.url));
    await build({
      entryPoints: [
        fileURLToPath(
          new URL("../../email/client/test/fixtures/editor.browser.ts", import.meta.url),
        ),
      ],
      outfile: join(directory, "renderer.js"),
      bundle: true,
      platform: "browser",
      logLevel: "silent",
      alias: Object.fromEntries(editorSharedPackages.map((name) => [name, client.resolve(name)])),
    });
    const electron = createRequire(import.meta.url)("electron") as string;
    const headless = process.platform === "linux" && !process.env.DISPLAY;
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete env.ELECTRON_RUN_AS_NODE;
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
        `Webmail editor browser test failed\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
        { cause: error },
      );
    });
    expect(result.stdout, result.stderr).toContain("Webmail editor browser checks passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
