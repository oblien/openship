// node-entry.ts — thin wrapper with a #!/usr/bin/env node shebang.
//
// npm reads the shebang of the `bin` file to generate the Windows launchers
// (openship.cmd / openship.ps1). dist/index.js uses #!/usr/bin/env sh — an
// intentional sh/JS polyglot that lets the official Bun-based installer run
// the CLI on Bun-only Unix boxes with no Node. On Windows, npm turns that `sh`
// into `sh.exe` calls, which don't exist on a standard install (#460).
//
// npm always ships Node, so this wrapper carries a plain `node` shebang and is
// the `bin` target: npm then emits correct launchers that call node.exe. On
// Unix it's equally valid — node runs the wrapper, which loads the fully
// bundled CLI. The polyglot dist/index.js is untouched and stays the exec
// target of the official curl/tarball installer on Bun-only boxes.
import "./index.js";
