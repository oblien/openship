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
  //
  // The first two lines are a sh/JS POLYGLOT launcher, not a plain shebang.
  // The official installer is Bun-only (no Node), while `npm i -g openship`
  // gives Node with no Bun — a single `#!/usr/bin/env node` or `bun` shebang
  // breaks one of those documented paths (#261). Under `sh` the second line
  // execs the CLI with whichever runtime exists (Bun preferred, else Node);
  // under Node/Bun that line is a harmless string + comment. `#!/usr/bin/env
  // sh` (not `#!/bin/sh`) is deliberate — install.sh's #21 heal matches the
  // first line EXACTLY against `#!/bin/sh`, so this never trips it.
  banner: {
    js: [
      "#!/usr/bin/env sh",
      '":" //# ; exec "$(command -v bun || command -v node)" "$0" "$@"',
      'import { createRequire as __ospCreateRequire } from "node:module";',
      "const require = __ospCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
