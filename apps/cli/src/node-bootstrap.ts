/**
 * Old-Node recovery for the package-manager install path.
 *
 * `npm i -g openship` is the only install path that runs on the user's own Node
 * (scripts/install.sh resolves its own — system >= 22 or it vendors one). Telling
 * that user "install Node 22+ and re-run" is a worse answer than we can give: the
 * CLI already knows how to fetch a private Node, because `openship update` calls
 * `ensureNodeRuntime()` for exactly this reason. This module points that same
 * function at the npm path, so the answer becomes an offer instead of a dead end.
 *
 * ── Why this is a separate bundle the gate imports DYNAMICALLY ────────────────
 *
 * node-entry.ts must be parseable by the old Node it is diagnosing — that is the
 * whole point of the gate, and it is why the CLI itself is loaded lazily there. If
 * this recovery code were bundled INTO node-entry.js, then the day something in the
 * `node-runtime` → `cache` → `paths` chain picks up a dependency with modern syntax,
 * node-entry.js would stop parsing and the gate would die with the same cryptic
 * SyntaxError it exists to prevent — the failure would be total and silent.
 *
 * Kept separate and loaded with `await import()` inside a try/catch, the worst case
 * is that recovery is unavailable and the operator gets the plain message. The gate
 * cannot be broken by this file.
 *
 * Today the whole chain is node-builtins-only (child_process, fs, path, os, crypto)
 * plus `fetch`/`AbortSignal.timeout`, all present in Node 18 — so recovery works on
 * every runtime the gate can catch.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { NODE_MAJOR, ensureNodeRuntime } from "./lib/node-runtime";
import { OS_DIR } from "./lib/paths";

/**
 * Set on a re-exec'd child so it never re-enters recovery.
 *
 * Without it, a vendored runtime that somehow still fails the floor (a partial
 * download, a repointed symlink, someone's stale runtime/current) would re-exec
 * itself forever instead of reporting a problem.
 */
export const NODE_REEXEC_ENV = "OPENSHIP_NODE_REEXEC";

/** Opt in (`1`) or out (`0`) of fetching Node without being asked — for CI. */
const VENDOR_ENV = "OPENSHIP_VENDOR_NODE";

/** Where a previously-vendored runtime lives (install.sh and `update` share it). */
const vendoredNode = (): string => join(OS_DIR, "runtime", "current", "bin", "node");

export interface RecoveryResult {
  /** True when the CLI has already been run on a satisfying Node. */
  handled: boolean;
  /** Exit status to propagate when `handled`. */
  status?: number;
}

function majorOf(bin: string): number {
  const out = spawnSync(bin, ["-e", "process.stdout.write(process.versions.node)"], {
    encoding: "utf8",
  });
  if (out.status !== 0) return 0;
  return Number.parseInt(out.stdout.trim().split(".")[0] ?? "", 10) || 0;
}

/** Run the real CLI under `nodeBin`, inheriting stdio, and return its status. */
function reexec(nodeBin: string, cliPath: string): RecoveryResult {
  const res = spawnSync(nodeBin, [cliPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [NODE_REEXEC_ENV]: "1" },
  });
  // A signalled child has a null status; 1 is the honest answer, not 0.
  return { handled: true, status: res.status ?? 1 };
}

/**
 * `[Y/n]` semantics: anything but an explicit "n…" is yes, including a bare Enter.
 *
 * Exported so the default is pinned by a test — the prompt itself needs a TTY, so
 * this is the only part of the interactive path a unit test can reach, and silently
 * inverting the default would turn "press Enter" from fixing the box into refusing.
 */
export function isAffirmative(answer: string): boolean {
  return !/^n/i.test(answer.trim());
}

function ask(question: string): Promise<boolean> {
  // Plain readline, NOT @clack/prompts — clack pulls string-width, whose `/v` regex
  // is the very thing that cannot be parsed on the Node versions we land here on.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(isAffirmative(answer));
    });
  });
}

/**
 * Try to run the CLI on a satisfying Node instead of refusing.
 *
 * Order matters: reuse before download, and never prompt for something already on
 * disk. A box that ran the official installer (or any earlier `openship update`)
 * already has a vendored Node 22 — using it silently is free and needs no consent.
 *
 * `offerDownload` is false for 20/21, which DO run: prompting on every invocation to
 * fix a setup that works would be nagging, so those only get the silent reuse.
 */
export async function recoverOldNode(opts: {
  cliPath: string;
  offerDownload: boolean;
  log: (msg: string) => void;
}): Promise<RecoveryResult> {
  const existing = vendoredNode();
  if (existsSync(existing) && majorOf(existing) >= NODE_MAJOR) {
    return reexec(existing, opts.cliPath);
  }

  if (!opts.offerDownload) return { handled: false };

  // Windows provisioning lives in scripts/install.ps1; nodeDistOs() would throw.
  if (process.platform === "win32") return { handled: false };

  const forced = process.env[VENDOR_ENV]?.trim();
  if (forced === "0") return { handled: false };

  if (forced !== "1") {
    // Not a terminal (CI, a service, a piped shell) → don't hang waiting on stdin.
    // The message the caller prints names OPENSHIP_VENDOR_NODE=1 for that case.
    if (!process.stdin.isTTY) return { handled: false };
    const yes = await ask(
      `\nOpenship can download its own Node ${NODE_MAJOR} (~50 MB) into ${OS_DIR}/runtime\n` +
        `and use it for Openship only — your system Node is left exactly as it is.\n\n` +
        `Download it now? [Y/n] `,
    );
    if (!yes) return { handled: false };
  }

  let nodeBin: string;
  try {
    nodeBin = (await ensureNodeRuntime(opts.log)).node;
  } catch (e) {
    opts.log(`Could not set up Node ${NODE_MAJOR}: ${(e as Error).message}`);
    return { handled: false };
  }
  // ensureNodeRuntime returns the string "node" when the SYSTEM node already
  // satisfies the floor — impossible here (we only get called when it doesn't), but
  // re-execing a bare "node" would just land back on the old runtime and loop.
  if (nodeBin === "node") return { handled: false };

  opts.log(`Using Node ${NODE_MAJOR} from ${OS_DIR}/runtime — future runs pick it up automatically.`);
  return reexec(nodeBin, opts.cliPath);
}
