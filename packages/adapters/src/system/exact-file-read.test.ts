import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { framedCatCommand, unframeFileRead } from "./exact-file-read";

/** What every executor does to command output before returning it. */
const execLikeAnExecutor = (command: string) =>
  execFileSync("sh", ["-c", command], { encoding: "utf-8" }).trim();

describe("framed file reads", () => {
  const cases: [string, string][] = [
    ["a vhost ending in a newline", "server {\n    listen 80;\n}\n"],
    ["leading blank lines", "\n\n# comment\nserver {}\n"],
    ["only whitespace", " \n\t\n"],
    ["an empty file", ""],
    ["a single quote in the content", "add_header X 'y';\n"],
  ];

  it.each(cases)("returns %s byte for byte through a trimming exec", (_label, content) => {
    const dir = mkdtempSync(join(tmpdir(), "openship-exact-read-"));
    try {
      const path = join(dir, "it's here.conf");
      writeFileSync(path, content);
      expect(unframeFileRead(execLikeAnExecutor(framedCatCommand(path)), path)).toBe(content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the shell command instead of printing a closing marker when cat fails", () => {
    expect(() => execLikeAnExecutor(framedCatCommand("/nonexistent/openship/x.conf"))).toThrow();
  });

  it("ignores what a chatty login shell prints before the payload", () => {
    const framed = execLikeAnExecutor(`echo "Welcome to Ubuntu"; ${framedCatCommand("/dev/null")}`);
    expect(unframeFileRead(framed, "/dev/null")).toBe("");
  });

  it("refuses output that is not framed rather than guessing at the content", () => {
    expect(() => unframeFileRead("server {}", "/x.conf")).toThrow(/Incomplete read of \/x\.conf/);
    expect(() => unframeFileRead("<openship-file>server {}", "/x.conf")).toThrow(/not framed/);
    expect(() => unframeFileRead("server {}</openship-file>", "/x.conf")).toThrow(/not framed/);
    expect(() => unframeFileRead("", "/x.conf")).toThrow(/not framed/);
  });
});
