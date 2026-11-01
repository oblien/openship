import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalExecutor } from "../../system/local-executor";
import { sq } from "../build-pipeline";
import { NohupSupervisor } from "./nohup";

// Exercise the fallback used by macOS even on Linux CI where setsid exists.
class WithoutSetsid extends LocalExecutor {
  override exec(command: string, opts?: { timeout?: number }): Promise<string> {
    return command.startsWith("command -v setsid ") ? Promise.resolve("n") : super.exec(command, opts);
  }
}

describe.skipIf(process.platform === "win32")("nohup process lifecycle", () => {
  it.each([
    { detached: false, ignoreTerm: false },
    { detached: false, ignoreTerm: true },
    { detached: true, ignoreTerm: true },
  ])("stops children and frees ports (isolated group: $detached, ignores TERM: $ignoreTerm)", async ({ detached, ignoreTerm }) => {
    const directory = await mkdtemp(join(tmpdir(), "openship-nohup-test-"));
    const release = join(directory, "release");
    await mkdir(release);
    const executor = new WithoutSetsid();
    const supervisor = new NohupSupervisor(executor, directory);
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    let child: { pid: number; port: number } | undefined;
    let parentPid: number | undefined;
    try {
      await writeFile(join(release, "child.mjs"), [
        'import { createServer } from "node:http";',
        'import { writeFileSync } from "node:fs";',
        'const server = createServer((_req, res) => res.end("supervised child"));',
        'server.listen(0, "127.0.0.1", () => writeFileSync("child.json", JSON.stringify({ pid: process.pid, port: server.address().port })));',
        ignoreTerm ? 'process.on("SIGTERM", () => {});' : 'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
      ].join("\n"));
      await writeFile(join(release, "parent.mjs"), [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'writeFileSync("parent.pid", String(process.pid));',
        'spawn(process.execPath, ["child.mjs"], { stdio: "ignore" });',
        'setInterval(() => {}, 1000);',
      ].join("\n"));
      if (detached) {
        // Node creates the same isolated group as setsid, including on macOS.
        // Reopen its saved PID through the supervisor to test the Linux stop path.
        const managed = spawn(process.execPath, ["parent.mjs"], { cwd: release, detached: true, stdio: "ignore" });
        parentPid = managed.pid;
        expect(parentPid).toBeGreaterThan(1);
        await executor.writeFile(join(directory, ".pids", "dep-tree.pid"), String(parentPid));
        expect(Number(await executor.exec(`ps -o pgid= -p ${parentPid}`))).toBe(parentPid);
      } else {
        await supervisor.deploy({
          deploymentId: "dep-tree", projectId: "project-tree", workDir: release,
          startCommand: `${sq(process.execPath)} parent.mjs`, port: 3000, env: {},
        });
      }
      await vi.waitFor(async () => {
        parentPid = Number(await readFile(join(release, "parent.pid"), "utf8"));
        child = JSON.parse(await readFile(join(release, "child.json"), "utf8"));
      });
      const url = `http://127.0.0.1:${child!.port}`;
      expect(await (await fetch(url)).text()).toBe("supervised child");

      await supervisor.stop("dep-tree");

      await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
      expect(await supervisor.isRunning("dep-tree")).toBe(false);
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    } finally {
      for (const pid of [child?.pid, parentPid]) {
        if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ } }
      }
      unrelated.kill("SIGKILL");
      await supervisor.destroy("dep-tree");
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
