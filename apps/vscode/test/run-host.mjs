import { runTests } from "@vscode/test-electron";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "openship-vscode-host-"));
const workspace = join(temporary, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "openship.json"), '{"framework":"not-an-openship-framework"}\n');
try {
  await runTests({
    extensionDevelopmentPath: process.env.OPENSHIP_EXTENSION_PATH || root,
    extensionTestsPath: join(root, "dist/test/host.cjs"),
    ...(process.env.OPENSHIP_VSCODE_EXECUTABLE
      ? { vscodeExecutablePath: process.env.OPENSHIP_VSCODE_EXECUTABLE }
      : { version: manifest.engines.vscode.replace(/^\^/, "") }),
    launchArgs: [
      workspace,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-gpu",
      "--no-sandbox",
      "--user-data-dir",
      join(temporary, "user-data"),
      "--extensions-dir",
      join(temporary, "extensions"),
    ],
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
