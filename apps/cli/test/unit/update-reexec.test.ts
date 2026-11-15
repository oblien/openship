import { describe, it, expect } from "vitest";

/**
 * `openship update` fetches the new bundle, then re-execs the freshly-fetched
 * binary to run the reconcile (`update --apply-only`) so the NEW compose template
 * / service unit lands in the same command. These pin the two subtle bits of that
 * re-exec: the argv ordering (`--json` is a ROOT option, so it must precede the
 * subcommand) and the loop guard (a re-exec'd child must never re-exec again).
 */

import { mkdtempSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOnlyArgv,
  freshInvocation,
  isReexecChild,
  REEXEC_ENV,
  targetVersionEnv,
  whichOnPath,
  TARGET_VERSION_ENV,
} from "../../src/lib/update-reexec";

describe("applyOnlyArgv", () => {
  it("appends the subcommand after the CLI's own entry args", () => {
    expect(applyOnlyArgv(["/opt/cli/dist/index.js"], false)).toEqual([
      "/opt/cli/dist/index.js",
      "update",
      "--apply-only",
    ]);
  });

  it("works for a launcher invocation with no entry args (tarball)", () => {
    expect(applyOnlyArgv([], false)).toEqual(["update", "--apply-only"]);
  });

  it("puts --json BEFORE the subcommand (root option, not `update --json`)", () => {
    const argv = applyOnlyArgv(["/opt/cli/dist/index.js"], true);
    expect(argv).toEqual([
      "/opt/cli/dist/index.js",
      "--json",
      "update",
      "--apply-only",
    ]);
    // The contract: --json must precede `update`, or the subcommand parser rejects it.
    expect(argv.indexOf("--json")).toBeLessThan(argv.indexOf("update"));
  });
});

describe("isReexecChild", () => {
  it("is true only when the sentinel env is exactly '1'", () => {
    expect(isReexecChild({ [REEXEC_ENV]: "1" })).toBe(true);
  });

  it("is false when the sentinel is unset or any other value", () => {
    expect(isReexecChild({})).toBe(false);
    expect(isReexecChild({ [REEXEC_ENV]: "0" })).toBe(false);
    expect(isReexecChild({ [REEXEC_ENV]: "true" })).toBe(false);
  });
});

describe("targetVersionEnv", () => {
  it("returns the version the fetch phase installed", () => {
    expect(targetVersionEnv({ [TARGET_VERSION_ENV]: "0.9.12-fork.1" })).toBe("0.9.12-fork.1");
  });

  it("is null when unset, and trims/ignores blank values", () => {
    expect(targetVersionEnv({})).toBeNull();
    expect(targetVersionEnv({ [TARGET_VERSION_ENV]: "  " })).toBeNull();
  });
});

describe("whichOnPath", () => {
  it("finds the first executable match on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-path-"));
    const bin = join(dir, "openship");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    try {
      expect(whichOnPath("openship", { PATH: "/nonexistent" + delimiterChar() + dir })).toBe(bin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips non-executable leftovers and returns null when nothing matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-path-"));
    writeFileSync(join(dir, "openship"), "not executable");
    try {
      expect(whichOnPath("openship", { PATH: dir })).toBeNull();
      expect(whichOnPath("openship", { PATH: "" })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("freshInvocation", () => {
  const fallback = { runtime: "/usr/bin/bun", args: ["/old/store/openship/dist/index.js"] };

  it("prefers the PATH bin over a stale argv[1] entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-path-"));
    const bin = join(dir, "openship");
    // A JS entry (env-node shebang): still executed under this process's
    // runtime — see the shell-launcher test below for the non-JS case.
    writeFileSync(bin, "#!/usr/bin/env node\n");
    chmodSync(bin, 0o755);
    try {
      const inv = freshInvocation(fallback, { PATH: dir });
      expect(inv.runtime).toBe(fallback.runtime);
      expect(inv.args[0]).toBe(bin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #13 review, reproduced: an older tarball launcher (a /bin/sh script) may
  // still precede the package-manager bin on PATH. Executing a shell script
  // through Node is a SyntaxError, exit 1 — so a non-JS shebang is executed
  // WHOLE (runtime = the file), letting the OS resolve the interpreter. The
  // launcher re-resolves node + cli/current itself, so the fresh tarball
  // bundle still runs the reconcile.
  it("executes a shell launcher through its shebang, not through node", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-path-"));
    const bin = join(dir, "openship");
    writeFileSync(bin, "#!/bin/sh\nexec echo hi\n");
    chmodSync(bin, 0o755);
    try {
      const inv = freshInvocation(fallback, { PATH: dir });
      expect(inv.runtime).toBe(bin);
      expect(inv.args).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps node for a shebang-less JS entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-path-"));
    const bin = join(dir, "openship");
    writeFileSync(bin, "process.exit(0);\n");
    chmodSync(bin, 0o755);
    try {
      const inv = freshInvocation(fallback, { PATH: dir });
      expect(inv.runtime).toBe(fallback.runtime);
      expect(inv.args[0]).toBe(bin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps node for a bun interpreter shebang", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-path-"));
    const bin = join(dir, "openship");
    writeFileSync(bin, "#!/usr/bin/env bun\n");
    chmodSync(bin, 0o755);
    try {
      const inv = freshInvocation(fallback, { PATH: dir });
      expect(inv.runtime).toBe(fallback.runtime);
      expect(inv.args[0]).toBe(bin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // End-to-end shape of the re-exec contract when the PATH bin is a shell
  // launcher: spawnSync(runtime=bin, applyOnlyArgv([])) must PARSE as
  // `update --apply-only` — the exact spawn reexecApply performs.
  it("re-execs a shell launcher with a parseable update --apply-only argv", async () => {
    const { spawnSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "openship-path-"));
    const bin = join(dir, "openship");
    writeFileSync(
      bin,
      '#!/bin/sh\n[ "$1" = update ] && [ "$2" = --apply-only ] && echo applied && exit 0\nexit 9\n',
    );
    chmodSync(bin, 0o755);
    try {
      const inv = freshInvocation(fallback, { PATH: dir });
      const res = spawnSync(inv.runtime, applyOnlyArgv(inv.args, false), { encoding: "utf8" });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("applied");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the fallback when PATH yields nothing", () => {
    expect(freshInvocation(fallback, { PATH: "/nonexistent" })).toEqual(fallback);
    expect(freshInvocation(fallback, { PATH: "" })).toEqual(fallback);
  });

  it("keeps the fallback when the PATH bin IS the fallback entry (replaced in place)", () => {
    const entry = "/usr/local/bin/openship";
    expect(freshInvocation({ runtime: "bun", args: [entry] }, { PATH: "/usr/local/bin" })).toEqual({
      runtime: "bun",
      args: [entry],
    });
  });

  // Tarball updates: the launcher takes the SUBCOMMAND directly (args []), so
  // the PATH bin must NOT become args[0] — that hand the launcher its own path
  // as a bogus first command and "update --apply-only" fails to parse.
  it("keeps the tarball launcher shape (args []) even when a bin is on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-path-"));
    const bin = join(dir, "openship");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const launcher = "/home/op/.openship/bin/openship";
    try {
      expect(freshInvocation({ runtime: launcher, args: [] }, { PATH: dir })).toEqual({
        runtime: launcher,
        args: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The runtime's PATH delimiter without importing a second path module here. */
function delimiterChar(): string {
  return process.platform === "win32" ? ";" : ":";
}
