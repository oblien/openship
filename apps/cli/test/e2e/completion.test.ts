/**
 * Black-box e2e: spawn the real assembled CLI (src/index.ts via tsx) and
 * verify shell completion works end to end. No mocks — same approach as
 * smoke.test.ts, since this needs the fully-wired `program`, including
 * attachCompletion(program), exactly as the built binary runs it.
 */
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..", "..");
const inject = join(here, "..", "helpers", "inject-version.mjs");
const entry = join(cliRoot, "src", "index.ts");
const NO_FILE_COMP_DIRECTIVE = ":4";

// tab always appends one trailing protocol line after the real candidates e.g. ":4",
// which is ShellCompDirectiveNoFileComp, telling the shell 
// "these ARE the complete results, don't fall back to filesystem path completion."
// It's present on every response, whether there are 0 or 10 real candidates,
// so tests need to strip it before asserting on the actual suggestion list.
// See https://github.com/bombshell-dev/tab (dist/index.mjs).
function candidatesFrom(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== NO_FILE_COMP_DIRECTIVE);
}

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const runtime = process.execPath.toLowerCase().endsWith("bun") ? "node" : process.execPath;
  return new Promise((resolve) => {
    execFile(
      runtime,
      ["--import", "tsx", "--import", pathToFileURL(inject).href, entry, ...args],
      { cwd: cliRoot, env: { ...process.env } },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: number }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

describe("cli completion", { timeout: 40_000 }, () => {

    it.each([
    { shell: "bash", marker: "complete -F __openship_complete openship" },
    { shell: "zsh", marker: "#compdef openship" },
    { shell: "fish", marker: "complete -c openship -e" },
    ])(
    "generates a valid %s completion script",
    async ({ shell, marker }) => {
        const { stdout, stderr, code } = await runCli(["completion", shell]);

        expect(code).toBe(0);
        expect(stderr).toBe("");
        expect(stdout).toContain(marker);
    },
    );

  it("suggests known top-level commands when nothing is typed yet", async () => {
    const { stdout, code } = await runCli(["complete", "--", ""]);
    expect(code).toBe(0);
    for (const cmd of ["deploy", "project", "service", "login"]) {
      expect(stdout).toContain(cmd);
    }
  });

  it("suggests matching subcommands for a partial word", async () => {
    // "proj" should resolve to "project"
    const { stdout, code } = await runCli(["complete", "--", "proj"]);
    expect(code).toBe(0);
    expect(stdout).toContain("project");
  });

    it("never suggests its own hidden completion plumbing", async () => {
    const { stdout } = await runCli(["complete", "--", ""]);
    expect(stdout).not.toContain("complete");
  });

  it("suggests flags for a known command", async () => {
    // Directly exercises the scenario named in the original issue:
    // `openship deploy --project <TAB>`.
    const { stdout, code } = await runCli(["complete", "--", "deploy", "--pro"]);
    expect(code).toBe(0);
    expect(stdout).toContain("--project");
  });

  it("suggests nothing for an unmatched prefix", async () => {
    const { stdout, code } = await runCli(["complete", "--", "zzz-not-real"]);
    expect(code).toBe(0);
    expect(candidatesFrom(stdout)).toEqual([]);
  });
  
});
