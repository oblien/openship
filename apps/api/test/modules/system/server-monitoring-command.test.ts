import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const src = readFileSync(
  fileURLToPath(new URL("../../../src/modules/system/server-check.controller.ts", import.meta.url)),
  "utf8",
);

describe("server monitoring STATS_COMMAND", () => {
  it("defines STATS_COMMAND with both Darwin and Linux support", () => {
    expect(src).toContain("export const STATS_COMMAND");
    expect(src).toContain('uname -s');
    expect(src).toContain('"Darwin"');
    expect(src).toContain("df -Pk");
    expect(src).toContain("iostat -c 2");
    expect(src).toContain("vm_stat");
    expect(src).toContain("hw.memsize");
    expect(src).toContain("kern.boottime");
  });

  it("extracts STATS_COMMAND and executes successfully on the host", () => {
    const match = src.match(/export const STATS_COMMAND = (\[[\s\S]*?\])\.join\(" "\);/);
    expect(match).not.toBeNull();
    const arrayStr = match![1];
    // Evaluate the array literal
    const commandArray = eval(arrayStr) as string[];
    const command = commandArray.join(" ");

    expect(typeof command).toBe("string");
    expect(command.length).toBeGreaterThan(0);

    const raw = execSync(command, { encoding: "utf8", shell: "/bin/bash", timeout: 10_000 });
    const parsed = JSON.parse(raw.trim());

    expect(typeof parsed.cpu).toBe("number");
    expect(parsed.cpu).toBeGreaterThanOrEqual(0);
    expect(parsed.cpu).toBeLessThanOrEqual(100);

    expect(Number(parsed.memTotal)).toBeGreaterThan(0);
    expect(Number(parsed.memUsed)).toBeGreaterThanOrEqual(0);
    expect(Number(parsed.memAvail)).toBeGreaterThanOrEqual(0);

    expect(Number(parsed.diskTotal)).toBeGreaterThan(0);
    expect(Number(parsed.diskUsed)).toBeGreaterThanOrEqual(0);
    expect(Number(parsed.diskAvail)).toBeGreaterThanOrEqual(0);

    expect(typeof parsed.uptime).toBe("string");
    expect(Number(parsed.uptime)).toBeGreaterThanOrEqual(0);

    expect(typeof parsed.load1).toBe("string");
    expect(typeof parsed.load5).toBe("string");
    expect(typeof parsed.load15).toBe("string");
  });
});
