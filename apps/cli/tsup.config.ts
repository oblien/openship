import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Inline the package version at build time so the CLI reports the released
// version without reading package.json at runtime (release.ts keeps it in sync).
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  define: { __CLI_VERSION__: JSON.stringify(version) },
  // Bundle the workspace packages (@repo/core, @repo/onboarding) INTO the
  // output. They're never published to npm, so an npx-installed `openship`
  // must carry them inline — otherwise it fails with ERR_MODULE_NOT_FOUND.
  // Runtime deps (commander, chalk, ora, open) stay external and come from
  // the published package's own dependencies.
  noExternal: [/^@repo\//],
  // The bundle is ESM, but @repo/adapters transitively pulls CJS deps (ws via
  // dockerode) that do `require("events")` etc. esbuild rewrites those to its
  // __require shim, which THROWS ('Dynamic require of "events" is not
  // supported') under Node because ESM modules have no `require` in scope. (It
  // never surfaced in dev — Bun defines `require` in ESM, so only the
  // Node-run published binary crashed.) Define a real `require` via
  // createRequire so the shim's `typeof require !== "undefined"` branch uses
  // it instead of throwing. This covers every bundled-CJS require of a Node
  // builtin at once.
  banner: {
    js: [
      'import { createRequire as __ospCreateRequire } from "node:module";',
      "const require = __ospCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
