import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { signDesktopUpdates } from "../scripts/sign-updates.mjs";

it("downloads and verifies redirected updates in real Electron, with cancellation and host checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openship-electron-update-"));
  try {
    const keys = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const bytes = "signed update fixture\n".repeat(1024);
    await writeFile(join(directory, "Openship.AppImage"), bytes);
    await writeFile(join(directory, "Openship.AppImage.sha256"), createHash("sha256").update(bytes).digest("hex"));
    await signDesktopUpdates({ directory, version: "9.8.7", ...keys });
    const entry = join(directory, "test.cjs");
    await build({
      entryPoints: [fileURLToPath(new URL("./fixtures/update-download.electron.ts", import.meta.url))],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      logLevel: "silent",
      plugins: [{
        name: "fixture-publisher-key",
        setup(builder) {
          builder.onLoad({ filter: /signing-public-key\.json$/ }, () => ({
            contents: JSON.stringify({ publicKey: keys.publicKey }), loader: "json",
          }));
        },
      }],
    });
    const electron = createRequire(import.meta.url)("electron") as string;
    const headless = process.platform === "linux" && !process.env.DISPLAY;
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete env.ELECTRON_RUN_AS_NODE;
    // CI cannot use Electron's SUID helper. This must be set before Electron
    // starts, not inside the fixture. No renderer or downloaded code is run;
    // the production application's sandbox is unchanged.
    const args = [...(process.platform === "linux" ? ["--no-sandbox"] : []), entry, directory];
    const result = await promisify(execFile)(headless ? "xvfb-run" : electron,
      headless ? ["-a", electron, ...args] : args,
      { env, timeout: 30_000, maxBuffer: 1024 * 1024 }).catch(error => {
        throw new Error(`Electron updater test failed (exit ${error.code}, signal ${error.signal ?? "none"})\n${error.stdout ?? ""}\n${error.stderr ?? ""}`, { cause: error });
      });
    expect(result.stdout).toContain("Electron updater regression checks passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
