/** Watch the same bundled main/preload used in the packaged app. */
import { spawn } from "node:child_process";
import { context } from "esbuild";
import { desktopBuildOptions, desktopRoot } from "../build/options.mjs";

const contexts = await Promise.all(desktopBuildOptions.map(options => context(options)));
await Promise.all(contexts.map(builder => builder.rebuild()));
await Promise.all(contexts.map(builder => builder.watch()));
const electron = spawn("npx", ["electronmon", "."], { cwd: desktopRoot, stdio: "inherit", env: process.env });
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  electron.kill();
  await Promise.all(contexts.map(builder => builder.dispose()));
  process.exit(code);
}
electron.on("error", () => void stop(1));
electron.on("close", code => void stop(code ?? 0));
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
