import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Inline the package version at build time so the CLI reports the released
// version without reading package.json at runtime (release.ts keeps it in sync).
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

// Both bundles need the CJS-compat shim so esbuild's __require helper works
// under Node ESM. The bundle is ESM, but @repo/adapters transitively pulls CJS
// deps (ws via dockerode) that do `require("events")` etc. esbuild rewrites
// those to its __require shim, which THROWS ('Dynamic require of "events" is
// not supported') under Node because ESM modules have no `require` in scope.
// (It never surfaced in dev — Bun defines `require` in ESM, so only the
// Node-run published binary crashed.) Define a real `require` via createRequire
// so the shim's `typeof require !== "undefined"` branch uses it instead of
// throwing. This covers every bundled-CJS require of a Node builtin at once.
const CJS_SHIM = [
  'import { createRequire as __ospCreateRequire } from "node:module";',
  "const require = __ospCreateRequire(import.meta.url);",
].join("\n");

// Two bundles because each needs its OWN shebang and tsup's `banner` is
// per-config, not per-entry. Configs run in array order, so Bundle 1's
// `clean: true` wipes dist/ before Bundle 2 (which must NOT clean) writes
// dist/node-entry.js beside it.
export default defineConfig([
  // ── Bundle 1: dist/index.js — the polyglot sh/JS launcher ──────────────
  // The first two banner lines are a sh/JS POLYGLOT launcher, not a plain
  // shebang. `npm i -g openship` gives Node, the curl installer gives Node too
  // now, but a box may have only Bun — a single `#!/usr/bin/env node` or `bun`
  // shebang breaks one of those paths (#261). Under `sh` the second line execs
  // the CLI with whichever runtime exists; under Node/Bun that line is a
  // harmless string + comment. NODE is preferred over Bun: Bun >= 1.3.4 aborts
  // on startup loading ssh2's native cpu-features addon (oven-sh/bun#18546,
  // #390), and Node is the tested/shipped runtime — Bun is only a last-resort
  // fallback on a Bun-only box. `#!/usr/bin/env sh` (not `#!/bin/sh`) is
  // deliberate — install.sh's #21 heal matched the first line EXACTLY against
  // `#!/bin/sh`, so this never trips it.
  {
    entry: { index: "src/index.ts" },
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
    banner: {
      js: [
        "#!/usr/bin/env sh",
        '":" //# ; exec "$(command -v node || command -v bun)" "$0" "$@"',
        CJS_SHIM,
      ].join("\n"),
    },
  },

  // ── Bundle 2: dist/node-entry.js — plain `node` shebang for npm ─────────
  // npm reads the shebang of `bin.openship` to generate Windows launchers.
  // If that were dist/index.js (polyglot `#!/usr/bin/env sh`), npm emits
  // `sh.exe` calls in openship.ps1/.cmd — which don't exist on a standard
  // Windows box, so every `npm i -g openship` breaks with "sh.exe not
  // recognized" (#460). This wrapper carries `#!/usr/bin/env node`, so npm
  // generates correct node.exe launchers; it just imports dist/index.js.
  {
    entry: { "node-entry": "src/node-entry.ts" },
    format: ["esm"],
    // NO clean — must not wipe dist/index.js built by Bundle 1 above.
    // Keep `./index.js` external so this stays a THIN wrapper: without it,
    // tsup follows the import and re-bundles the entire CLI into
    // node-entry.js — a second ~300KB copy that runs program.parse() twice.
    // With it external, node-entry.js is a literal runtime `import
    // "./index.js"` that loads the sibling polyglot bundle (Node strips its
    // sh shebang on import). No CJS shim needed here — the wrapper bundles
    // nothing.
    esbuildPlugins: [
      {
        name: "keep-index-external",
        setup(build) {
          build.onResolve({ filter: /^\.\/index\.js$/ }, (args) => ({
            path: args.path,
            external: true,
          }));
        },
      },
    ],
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
