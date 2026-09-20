/**
 * There is ONE shell-quoting implementation on the backup path.
 *
 * There were seven: `@repo/core`'s `shellQuote` plus a byte-identical private
 * `shellEscape` in each of three producers and three executors. Identical is the
 * dangerous kind of duplicate — it reads as harmless right up until one copy is
 * "improved", and every one of these sites interpolates operator-supplied values
 * (database passwords, usernames, tar exclude patterns) into a `sh -c` string. The
 * repo's own rule is to shell-quote every remote-exec argument; that rule needs a
 * single subject.
 *
 * Asserted against the source text rather than behaviour, because the failure this
 * prevents is someone re-adding a local copy, which no behavioural test would notice.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "@repo/core";

const ROOT = join(__dirname, "..", "src", "backup");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("shell quoting has exactly one implementation", () => {
  it("defines no local quoting helper anywhere under src/backup", () => {
    const offenders = sourceFiles(ROOT).filter((f) => {
      const src = readFileSync(f, "utf8");
      return /function\s+shell(Escape|Quote)\s*\(/.test(src);
    });
    expect(offenders.map((f) => f.replace(ROOT, "src/backup"))).toEqual([]);
  });

  it("round-trips every nasty value through a REAL shell", () => {
    // The property that matters, verified by execution rather than by hand-counting
    // backslashes in an expected string. (An earlier version of this test asserted the
    // escaped form literally and got it wrong — which is the whole argument for having
    // one implementation and testing it behaviourally.)
    //
    // Each of these is something an operator can legitimately put in a database password
    // or a tar exclude pattern, and every one of them ends up inside `sh -c`.
    const nasty = [
      "plain",
      "it's",
      "a'\\''b", // already looks like an escape sequence
      "$(whoami)",
      "`id`",
      "; rm -rf /",
      '"double"',
      "back\\slash",
      "new\nline",
      "$HOME",
      "a'b'c",
      "*",
      "",
    ];

    for (const value of nasty) {
      const res = spawnSync("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`]);
      expect(res.status, `exit for ${JSON.stringify(value)}`).toBe(0);
      expect((res.stdout ?? Buffer.alloc(0)).toString(), JSON.stringify(value)).toBe(value);
    }
  });

  it("keeps a value inert — the shell must never evaluate it", () => {
    // Round-tripping is not enough on its own: `$(whoami)` could round-trip AND have been
    // executed. This asserts the substitution never ran.
    const res = spawnSync("/bin/sh", ["-c", `printf %s ${shellQuote("$(id -u)")}`]);
    expect((res.stdout ?? Buffer.alloc(0)).toString()).toBe("$(id -u)");
  });
});
