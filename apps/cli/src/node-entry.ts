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
//
// ── It is also the Node-version gate, and that is why the import is dynamic ──
//
// `npm i -g openship` is the ONE install path that runs on the user's own Node.
// The curl installer resolves this itself (scripts/install.sh: system Node >= 22
// or it vendors an official Node 22), so it can never land on an old runtime —
// but npm/pnpm/yarn/bun installs land on whatever is there, and `engines` is only
// a WARNING unless the user set engine-strict.
//
// On Node 18 the result was: install exits 0, the bin links fine, and the command
// dies instantly with `SyntaxError: Invalid regular expression flags` from
// string-width's `/v` flag — a transitive dependency the user has never heard of.
// That reads as a broken install, not as "wrong Node", and it cost at least one
// operator an afternoon of chasing the wrong thing.
//
// The check therefore has to run BEFORE the CLI bundle is evaluated, which rules
// out a static `import "./index.js"`: ESM evaluates a module's imports before its
// own body, so the SyntaxError would win the race and this file's message would
// never print. A dynamic import defers the load until after the gate. (tsup keeps
// `./index.js` external via the keep-index-external plugin — dynamic imports go
// through the same onResolve hook, so this stays a runtime load of the sibling
// bundle rather than a second inlined copy of the whole CLI.)

import { fileURLToPath } from "node:url";

/** Floor below which the CLI CANNOT run — recovery, or a stop with an explanation. */
const HARD_FLOOR = 20;
/** Supported floor (package.json engines, scripts/install.sh, .node-version). */
const SUPPORTED = 22;

const INSTALLER = "curl -fsSL https://get.openship.io | sh";

const CLI_PATH = fileURLToPath(new URL("./index.js", import.meta.url));
const log = (msg: string) => process.stderr.write(`${msg}\n`);

// Bun reports a Node-compat version in process.versions.node, and the polyglot
// launcher deliberately runs the CLI under Bun on Bun-only boxes. Never gate that
// path on a number that describes Node.
const runningBun = typeof process.versions.bun === "string";
const major = Number.parseInt(process.versions.node?.split(".")[0] ?? "", 10);
// A child re-exec'd onto a good Node must never re-enter recovery — that is what
// stops a runtime which still fails the floor from re-execing itself forever.
const reexeced = process.env.OPENSHIP_NODE_REEXEC === "1";
const tooOld = !runningBun && !reexeced && Number.isFinite(major) && major < SUPPORTED;

if (tooOld) {
  // Recovery: reuse a Node this box already vendored, or offer to fetch one — the
  // same ensureNodeRuntime() `openship update` uses, so there is one implementation
  // of "get a Node that satisfies the floor", not two.
  //
  // Loaded dynamically inside a try/catch on purpose. If anything in its import
  // chain ever stops parsing on an old Node, recovery goes away and the operator
  // gets the message below — whereas bundling it in would break the gate itself
  // with exactly the SyntaxError the gate exists to replace.
  try {
    const { recoverOldNode } = await import("./node-bootstrap.js");
    const outcome = await recoverOldNode({
      cliPath: CLI_PATH,
      // 20 and 21 DO run: reuse a Node already on disk, but don't prompt to download
      // one on every invocation to fix a setup that already works.
      offerDownload: major < HARD_FLOOR,
      log,
    });
    if (outcome.handled) process.exit(outcome.status ?? 0);
  } catch {
    /* recovery unavailable — fall through to the message */
  }

  if (major < HARD_FLOOR) {
    process.stderr.write(
      `\nOpenship needs Node ${SUPPORTED} or newer — this is Node v${process.versions.node}.\n\n` +
        `  Install Node ${SUPPORTED}+ and re-run, or use the official installer, which\n` +
        `  brings its own Node and doesn't touch the one you have:\n\n` +
        `    ${INSTALLER}\n\n` +
        `  Non-interactive (CI, a service)? Set OPENSHIP_VENDOR_NODE=1 and Openship\n` +
        `  fetches its own Node ${SUPPORTED} without asking.\n\n` +
        `If you upgrade Node with a version manager (nvm, fnm, volta), global packages\n` +
        `live per Node version — reinstall the CLI afterwards or the command will go\n` +
        `missing: npm i -g openship\n\n`,
    );
    process.exit(1);
  }

  // Below the supported floor but still runnable. Warn rather than block: bricking
  // an install that works today to enforce a number we only just started publishing
  // would be a worse bug than the one this gate exists to fix.
  process.stderr.write(
    `Warning: Node v${process.versions.node} is below Openship's supported floor ` +
      `(Node ${SUPPORTED}+). It may work; it isn't tested. Upgrade, or install with:\n` +
      `  ${INSTALLER}\n`,
  );
}

await import("./index.js");
