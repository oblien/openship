import { build, context } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const resolve = (path) => fileURLToPath(new URL(path, import.meta.url));
await mkdir(resolve("dist"), { recursive: true });
await mkdir(resolve("schemas"), { recursive: true });
await copyFile(
  resolve("../web/public/openship.schema.json"),
  resolve("schemas/openship.schema.json"),
);
await copyFile(resolve("../web/public/apple-touch-icon.png"), resolve("media/icon.png"));
await copyFile(resolve("../../LICENSE"), resolve("LICENSE"));
const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const options = {
  absWorkingDir: root,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap: true,
  metafile: true,
  define: { __EXTENSION_VERSION__: JSON.stringify(manifest.version) },
  logLevel: "info",
};
if (process.argv.includes("--watch")) {
  const watcher = await context(options);
  await watcher.watch();
} else {
  const result = await build(options);
  await writeFile(resolve("dist/meta.json"), JSON.stringify(result.metafile, null, 2));
  await build({
    ...options,
    entryPoints: ["test/host/index.ts"],
    outfile: "dist/test/host.cjs",
    metafile: false,
  });
}
