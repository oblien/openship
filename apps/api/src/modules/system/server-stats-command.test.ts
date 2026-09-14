import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  STATS_COMMAND,
  LINUX_STATS_COMMAND,
  DARWIN_STATS_COMMAND,
} from "./server-check.controller";

const execFileAsync = promisify(execFile);

/**
 * `STATS_COMMAND` is a raw shell string shipped to whatever remote box a
 * server row points at — it is never parsed or type-checked, so a broken
 * branch only ever surfaces as silent dashes in the System Health panel
 * (GH-in-review). These tests catch that class of regression locally:
 * a syntax error in EITHER branch, and the Linux branch actually failing
 * to run and emit the schema the dashboard expects.
 *
 * The Darwin branch can only be syntax-checked here (`sysctl`/`vm_stat`/
 * `top` don't exist on the Linux CI runner) — it was hand-verified against
 * a real macOS box during review.
 */
describe("STATS_COMMAND", () => {
  it("both branches are syntactically valid bash", async () => {
    // `bash -n` parses without executing — catches the exact class of bug
    // this suite exists for (an unbalanced quote/paren silently wedging the
    // whole probe) without needing a macOS host to run it on.
    await expect(execFileAsync("bash", ["-n", "-c", LINUX_STATS_COMMAND])).resolves.toBeDefined();
    await expect(execFileAsync("bash", ["-n", "-c", DARWIN_STATS_COMMAND])).resolves.toBeDefined();
    await expect(execFileAsync("bash", ["-n", "-c", STATS_COMMAND])).resolves.toBeDefined();
  });

  it("dispatches on uname -s without any prior knowledge of the target's OS", () => {
    expect(STATS_COMMAND).toContain('if [ "$(uname -s)" = "Darwin" ]');
    expect(STATS_COMMAND).toContain(DARWIN_STATS_COMMAND);
    expect(STATS_COMMAND).toContain(LINUX_STATS_COMMAND);
  });

  it(
    "the Darwin branch avoids `<<<` (zsh spills here-strings to a temp file, which " +
      "fails this very probe with ENOSPC on the near-full disk an operator most wants " +
      "a reading from)",
    () => {
      expect(DARWIN_STATS_COMMAND).not.toContain("<<<");
    },
  );

  it("the Linux branch runs on this (Linux) CI runner and emits the documented schema", async () => {
    const { stdout } = await execFileAsync("bash", ["-c", LINUX_STATS_COMMAND]);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toMatchObject({
      cpu: expect.any(Number),
      memTotal: expect.any(Number),
      memUsed: expect.any(Number),
      memAvail: expect.any(Number),
      diskTotal: expect.any(Number),
      diskUsed: expect.any(Number),
      diskAvail: expect.any(Number),
      uptime: expect.any(String),
      load1: expect.any(String),
      load5: expect.any(String),
      load15: expect.any(String),
    });
  });
});
