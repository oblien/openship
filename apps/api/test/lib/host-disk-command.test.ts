import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The disk probe is the one place in the capacity path that shells out (free
 * space isn't readable over the Docker API). Its safety rests on the command
 * being a CONSTANT: the path it measures is resolved on the host by `docker
 * info`, so no caller-supplied value — `serverId` least of all — ever reaches a
 * shell. Asserted structurally, the same way the host-capacity guard is: a
 * behavioral test would have to mock the whole executor graph and would stop
 * proving anything about the real command string.
 */
const src = readFileSync(
  fileURLToPath(new URL("../../src/lib/host-disk.ts", import.meta.url)),
  "utf8",
);

describe("host-disk probe", () => {
  it("builds the command from constants only — no interpolation", () => {
    const start = src.indexOf("const DISK_COMMAND");
    expect(start, "DISK_COMMAND not found").toBeGreaterThan(-1);
    const decl = src.slice(start, src.indexOf(";", src.indexOf("df -Pk", start)));
    // No template literals and no `+ variable` concatenation: every piece is a
    // quoted literal.
    expect(decl).not.toMatch(/`/);
    expect(decl).not.toMatch(/\$\{/);
    expect(decl.split("+").every((part) => /^\s*(const DISK_COMMAND[^=]*=)?\s*['"]/.test(part))).toBe(
      true,
    );
  });

  it("execs exactly one command, and only that constant", () => {
    const execCalls = [...src.matchAll(/\.exec\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(execCalls).toEqual(["DISK_COMMAND"]);
  });

  it("gates on CLOUD_MODE before resolving any executor", () => {
    const fnStart = src.indexOf("export async function getHostDisk");
    expect(fnStart).toBeGreaterThan(-1);
    const guardAt = src.indexOf("env.CLOUD_MODE", fnStart);
    const execAt = src.indexOf("resolveServerExecutor(", fnStart);
    expect(guardAt).toBeGreaterThan(fnStart);
    expect(execAt).toBeGreaterThan(guardAt);
  });

  it("never throws — an unreachable host reports unknown", () => {
    expect(src).toMatch(/catch\s*\{\s*return\s*\{\s*\.\.\.UNKNOWN_DISK\s*\}/);
  });
});
