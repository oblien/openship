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

export default defineConfig([
  // ── Bundle 1: dist/index.js — polyglot sh/JS launcher ──────────────────
  // Used by the official curl-based installer on Bun-only Unix boxes.
  // The first two lines are a sh/JS POLYGLOT launcher, not a plain shebang.
  // `npm i -g openship` gives Node, the curl installer gives Node too now, but
  // a box may have only Bun — a single `#!/usr/bin/env node` or `bun` shebang
  // breaks one of those paths (#261). Under `sh` the second line execs the CLI
  // with whichever runtime exists; under Node/Bun that line is a harmless
  // string + comment. NODE is preferred over Bun: Bun >= 1.3.4 aborts on
  // startup loading ssh2's native cpu-features addon (oven-sh/bun#18546, #390),
  // and Node is the tested/shipped runtime — Bun is only a last-resort fallback
  // on a Bun-only box. `#!/usr/bin/env sh` (not `#!/bin/sh`) is deliberate —
  // install.sh's #21 heal matched the first line EXACTLY against `#!/bin/sh`,
  // so this never trips it.
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
        '":"; //# ; exec "$(command -v node || command -v bun)" "$0" "$@"',
        CJS_SHIM,
      ].join("\n"),
    },
  },

  // ── Bundle 2: dist/node-entry.js — Node shebang for npm on Windows ──────
  // npm reads the shebang of `bin.openship` to generate Windows launchers.
  // dist/index.js uses #!/usr/bin/env sh (polyglot, intentional — see above),
  // which causes npm to emit `sh.exe` calls on Windows — breaking every
  // `npm i -g openship` on Windows with "sh.exe not recognized".
  //
  // This wrapper has #!/usr/bin/env node so npm generates correct
  // openship.cmd / openship.ps1 launchers calling node.exe. It simply
  // imports the fully-bundled CLI from dist/index.js.
  //
  // On Unix, #!/usr/bin/env node is also valid — node runs this wrapper,
  // which loads the CLI. The polyglot dist/index.js is only used by the
  // official Bun-based installer on Bun-only boxes (not npm).
  {
    entry: { "node-entry": "src/node-entry.ts" },
    format: ["esm"],
    // No clean: true — must not wipe dist/index.js built by Bundle 1 above.
    define: { __CLI_VERSION__: JSON.stringify(version) },
    noExternal: [/^@repo\//],
    banner: {
      js: ["#!/usr/bin/env node", CJS_SHIM].join("\n"),
    },
  },
]);
