import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic-json";

const directories: string[] = [];

function dir(): string {
  const directory = mkdtempSync(join(tmpdir(), "openship-atomic-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("writeJsonAtomic", () => {
  it("writes pretty JSON and leaves no temp file", () => {
    const file = join(dir(), "config.json");
    writeJsonAtomic(file, { ok: true });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ ok: true });
    expect(readdirSync(join(file, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces an existing file without leaving it truncated", () => {
    const file = join(dir(), "ports.json");
    writeFileSync(file, "{");
    writeJsonAtomic(file, { api: 54777, dashboard: 54778 });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ api: 54777, dashboard: 54778 });
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
    expect(existsSync(`${file}.bak`)).toBe(false);
  });

  it("leaves dest valid after replacing an existing dest twice", () => {
    const file = join(dir(), "config.json");
    writeJsonAtomic(file, { n: 1 });
    writeJsonAtomic(file, { n: 2 });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ n: 2 });
    expect(readdirSync(join(file, "..")).filter((name) => name.endsWith(".tmp") || name.endsWith(".bak"))).toEqual(
      [],
    );
  });
});
