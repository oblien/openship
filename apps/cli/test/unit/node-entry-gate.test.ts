import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `npm i -g openship` is the only install path that runs on the USER's Node — the
 * curl installer resolves Node itself (scripts/install.sh: system >= 22, else it
 * vendors one). With no floor declared, npm installed onto Node 18 with a warning
 * that named `commander`, exited 0, linked the bin, and then the command died with
 * `SyntaxError: Invalid regular expression flags` out of string-width's `/v` flag.
 * That reads as a broken install rather than a wrong Node, and it sent at least one
 * operator down a multi-hour detour.
 *
 * So node-entry.ts gates on the Node major before loading the CLI. The gate is only
 * worth anything if it runs FIRST, which is what these pin — a text-level check,
 * because the failure it guards against is a load-order regression that no unit test
 * calling into the module could observe (importing it here would run the gate against
 * the test runner's own Node).
 */

const CLI_ROOT = join(import.meta.dirname, "../..");
const ENTRY = readFileSync(join(CLI_ROOT, "src/node-entry.ts"), "utf8");
const PKG = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8")) as {
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  name: string;
};

describe("the Node gate in node-entry.ts", () => {
  it("loads the CLI through a DYNAMIC import, so the gate wins the race", () => {
    // The whole point. ESM evaluates a module's imports before its own body, so a
    // static `import "./index.js"` would run the CLI — and hit the SyntaxError on an
    // old Node — before a single line of the gate executed. Nothing about that failure
    // would look like a load-order bug; the gate would just silently never print.
    expect(ENTRY).toContain('await import("./index.js")');
    expect(ENTRY).not.toMatch(/^\s*import\s+["']\.\/index\.js["']/m);
  });

  it("hard-stops below the floor and names the runtime it found", () => {
    expect(ENTRY).toContain("process.exit(1)");
    // The message has to carry the version in hand — "needs Node 22" alone leaves the
    // operator guessing which Node the command actually picked up, which is the exact
    // confusion when a version manager has several installed.
    expect(ENTRY).toContain("process.versions.node");
  });

  it("never gates the Bun path on a Node number", () => {
    // dist/index.js is an sh/JS polyglot that runs the CLI under Bun on Bun-only boxes,
    // and Bun reports a Node-COMPAT version in process.versions.node. Reading that as
    // the real runtime would refuse to start on a box that works fine.
    expect(ENTRY).toContain("process.versions.bun");
  });

  it("warns rather than blocks between the hard floor and the supported one", () => {
    // 20 and 21 run today. Bricking a working install to enforce a floor we only just
    // started publishing would be a worse regression than the bug being fixed.
    expect(ENTRY).toMatch(/HARD_FLOOR\s*=\s*20/);
    expect(ENTRY).toMatch(/SUPPORTED\s*=\s*22/);
  });
});

describe("the recovery bundle stays loadable on the Node it recovers", () => {
  // node-bootstrap.ts reuses ensureNodeRuntime() — the same function `openship update`
  // calls — so there is ONE implementation of "get a Node that satisfies the floor".
  // That only works if its whole import chain parses on the old Node: a single
  // third-party dependency with modern syntax (string-width's `/v` flag is the exact
  // precedent) would make recovery unavailable on the runtimes that need it most.
  // Checked on the SOURCE graph so it holds without a build.
  const CHAIN = [
    "src/node-bootstrap.ts",
    "src/lib/node-runtime.ts",
    "src/lib/cache.ts",
    "src/lib/paths.ts",
  ];

  it.each(CHAIN)("%s imports node builtins and repo-local modules only", (rel) => {
    const src = readFileSync(join(CLI_ROOT, rel), "utf8");
    const specifiers = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map(
      (m) => m[1]!,
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      const ok = spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../");
      expect(ok, `${rel} imports "${spec}" — third-party code breaks recovery on old Node`).toBe(
        true,
      );
    }
  });

  it("never re-enters recovery in a re-exec'd child", () => {
    // Otherwise a vendored runtime that still fails the floor re-execs itself forever.
    expect(ENTRY).toContain("OPENSHIP_NODE_REEXEC");
    const bootstrap = readFileSync(join(CLI_ROOT, "src/node-bootstrap.ts"), "utf8");
    expect(bootstrap).toContain("NODE_REEXEC_ENV");
  });

  it("only offers a download below the hard floor", () => {
    // 20 and 21 run: reuse a vendored Node silently, but don't prompt on every
    // invocation to fix a setup that already works.
    expect(ENTRY).toContain("offerDownload: major < HARD_FLOOR");
  });

  it("prompts with readline, never with the CLI's prompt library", () => {
    // @clack/prompts pulls string-width — the dependency whose `/v` regex is the
    // original crash. Using it to ask about the crash would reproduce it.
    const bootstrap = readFileSync(join(CLI_ROOT, "src/node-bootstrap.ts"), "utf8");
    expect(bootstrap).toContain("node:readline");
    // An IMPORT of it, not a mention — the comment above the prompt names clack to
    // explain why it isn't used here.
    expect(bootstrap).not.toMatch(/^\s*import[^;]*@clack/m);
  });
});

describe("the download prompt", () => {
  it("treats a bare Enter as yes, and only an explicit n as no", async () => {
    // The prompt reads `[Y/n]`. Inverting this default would turn "press Enter" from
    // fixing the box into refusing to run — and the prompt needs a TTY, so this is the
    // only part of that path reachable without one.
    const { isAffirmative } = await import("../../src/node-bootstrap");
    for (const yes of ["", "  ", "y", "Y", "yes", "sure"]) {
      expect(isAffirmative(yes), `"${yes}" should be yes`).toBe(true);
    }
    for (const no of ["n", "N", "no", "  nope"]) {
      expect(isAffirmative(no), `"${no}" should be no`).toBe(false);
    }
  });
});

describe("the published package manifest", () => {
  it("declares the Node floor, so npm's warning names openship", () => {
    // Advisory unless the user set engine-strict — but it makes the warning point at
    // the right package instead of at a transitive dependency.
    expect(PKG.engines?.node).toBe(">=22");
  });

  it("does not depend on itself", () => {
    // Shipped in 0.6.0 and 0.6.1: `"openship": "^0.5.0"` landed by accident, so every
    // install unpacked a second, older CLI under
    // lib/node_modules/openship/node_modules/openship, plus its whole dep tree.
    expect(Object.keys(PKG.dependencies ?? {})).not.toContain(PKG.name);
  });
});
