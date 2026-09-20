/** Public assembly only. Product implementations remain in their owning workspaces. */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const packageDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(packageDir, "../..");
const dist = join(packageDir, "dist");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

if (!process.argv.includes("--check")) {
  execFileSync("bun", ["run", "--cwd", join(root, "apps/cli"), "build"], { cwd: root, stdio: "inherit" });
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  cpSync(join(root, "apps/cli/dist"), dist, { recursive: true });
  execFileSync("bun", ["run", "--cwd", join(root, "packages/platform"), "build:native"], { cwd: root, stdio: "inherit" });
  mkdirSync(join(dist, "native"));
  cpSync(join(root, "packages/platform/dist/native/engine-worker.mjs"), join(dist, "native/engine-worker.mjs"));
  cpSync(join(root, "packages/platform/dist/native/lua"), join(dist, "native/lua"), { recursive: true });
  // Resolve declarations in the distribution's dependency context. Private
  // @repo packages are bundled types, never external public dependencies.
  await build({
    entry: Object.fromEntries(["index", "native", "client"].map((entry) => [entry, join(root, `packages/sdk/src/${entry}.ts`)])),
    tsconfig: join(root, "packages/sdk/tsconfig.json"),
    outDir: join(dist, "sdk"), format: ["esm", "cjs"], target: "node22",
    dts: {
      resolve: [/^@repo\//],
      compilerOptions: {
        baseUrl: root,
        paths: {
          ...Object.fromEntries(["sdk", "platform", "contracts", "core"].map(name => [`@repo/${name}`, [`packages/${name}/src/index.ts`]])),
          "@repo/platform/native": ["packages/platform/src/native-host.ts"],
          "@repo/platform/source-files": ["packages/platform/src/source-files.ts"],
          "@repo/db/lock": ["packages/db/src/pglite-lock.ts"],
        },
      },
    },
    noExternal: [/^@repo\//],
  });
  cpSync(join(root, "LICENSE"), join(packageDir, "LICENSE"));
}

if (manifest.name !== "openship" || manifest.private) throw new Error("Invalid public package ownership");
if (JSON.stringify(manifest).includes("workspace:")) throw new Error("The public package contains an unresolved workspace dependency");
const cliManifest = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8"));
if (manifest.version !== cliManifest.version) throw new Error("SDK and CLI release versions must match");
for (const file of [
  "node-entry.js", "node-bootstrap.js", "index.js", "server/index.js", "native/engine-worker.mjs",
  "server/pglite/pglite.wasm", "server/pglite/pglite.data", "server/migrations/meta/_journal.json",
  ...["index", "native", "client"].flatMap((name) => ["js", "cjs", "d.ts", "d.cts"].map((ext) => `sdk/${name}.${ext}`)),
]) if (!existsSync(join(dist, file))) throw new Error(`Missing public package artifact: dist/${file}. Run bun run build.`);

let bytes = 0;
function inspect(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inspect(path);
    else {
      bytes += statSync(path).size;
      if (/\.(?:[cm]?js|d\.[cm]?ts)$/.test(entry.name)) {
        const source = readFileSync(path, "utf8");
        if (/(?:from\s*|import\s*\(|require\s*\()\s*["']@repo\//.test(source))
          throw new Error(`Unpublished workspace import in ${path}`);
      }
    }
  }
}
inspect(dist);
console.log(`[openship] SDK, declarations, CLI and server assets verified (${(bytes / 1024 / 1024).toFixed(1)} MB unpacked)`);
