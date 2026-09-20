import { describe, expect, it, vi } from "vitest";
import { BareRuntime, STATIC_RELEASE_BASE } from "./bare";
import { probeOutput } from "../system/environment.fixtures";
import type { CommandExecutor } from "../types";

/**
 * Regression for issue #514 — a static site deployed to a REMOTE SSH server
 * whose deploy user is not root.
 *
 * Two things went wrong on that box. Both are exercised here through
 * `deployStatic`, the last step of the deploy:
 *
 *   1. nothing under `/opt/openship` was writable by the deploy user, and no
 *      preflight provisioned it, so the promote's `mkdir releases` failed. (The
 *      reporter's box was a first-ever deploy that died earlier still, in the
 *      build's doc-root extract — same missing-provisioning cause, different
 *      call site.)
 *   2. the promote is journaled, and the journal base was hardcoded to
 *      `/root/.openship` — unreadable for this user, so `ensureRemoteJournal`
 *      died SFTP-writing `bin/opsh-run` and the `mv` was never issued.
 *      `releases/` stayed empty while `.builds/<id>` was reaped by cleanup.
 *
 * Both surfaced as the same opaque "Deploy failed: Permission denied".
 */

const BUILD_DIR = `${STATIC_RELEASE_BASE}/.builds/build_1`;
const RELEASE_DIR = `${STATIC_RELEASE_BASE}/releases/dep_1`;
const HOME = "/home/deploy";

/**
 * A remote box exactly like the reporter's: login user `deploy` (uid 1000) with
 * passwordless sudo, `/root` unreadable, and `/opt/openship/static` root-owned.
 * Anything the user can't write fails until an elevated command chowns it.
 */
function remoteNonRootServer() {
  const commands: string[] = [];
  const owned = new Set<string>([HOME, `${STATIC_RELEASE_BASE}/.builds`]);
  const denied = () => new Error("Permission denied");
  const isOurs = (p: string) => [...owned].some((o) => p === o || p.startsWith(`${o}/`));

  const executor = {
    exec: vi.fn(async (command: string) => {
      commands.push(command);
      // `resolveEnvironment`'s single-shot probe: this exact box — non-root `deploy`
      // (uid 1000) with passwordless sudo and its home at $HOME. Answered before the
      // `$HOME` branch below, which the probe script's `opsh_home=$HOME` would otherwise
      // swallow.
      if (command.includes("opsh_begin")) {
        return probeOutput({ uid: "1000", user: "deploy", home: HOME, sudo: "y" });
      }
      if (command.includes("$HOME")) return `${HOME}\n`;
      if (command === "id -u") return "1000";
      if (command === "id -un" || command === "id -gn") return "deploy\n";
      if (command.startsWith("sudo -n true")) return "yes";
      if (command.startsWith("sudo -n ")) {
        // Root can create anything, and hands it to the login user.
        const target = command.match(/mkdir -p '\\''([^']+)'\\''/)?.[1];
        if (target) owned.add(target);
        return "";
      }
      if (/^(mkdir -p|rm -rf|mv) /.test(command) || command.includes("&& [ -w ")) {
        const target = command.match(/'([^']+)'/)?.[1] ?? "";
        if (!isOurs(target)) throw denied();
        if (command.startsWith("mkdir -p")) owned.add(target);
        return "";
      }
      // The journal wrapper: only reachable under a directory we own.
      if (command.includes("/.openship")) {
        if (!isOurs(HOME)) throw denied();
        // A box that has never journaled: no wrapper, so `ensureRemoteJournal`
        // takes the deploy branch and SFTP-writes bin/opsh-run — which IS the
        // operation that failed. Answering the live version here instead would
        // skip the write and model the one state where the bug cannot happen.
        if (command.includes("--version")) return "0";
        if (command.includes("--gc")) return "";
        return "OPSH1 0  ";
      }
      // isEmptyDir's doc-root probe — the extracted files are there.
      if (command.startsWith("if [ -d ")) return "DIR\nindex.html\n";
      return "";
    }),
    streamExec: vi.fn(async () => ({ code: 0, output: "" })),
    writeFile: vi.fn(async (path: string) => {
      if (!isOurs(path)) throw denied();
    }),
    readFile: vi.fn(async () => ""),
    exists: vi.fn(async (p: string) => p === BUILD_DIR || p === RELEASE_DIR),
    // SshExecutor.mkdir is `exec("mkdir -p …")` — unelevated, so it is bound by
    // the same ownership as everything else.
    mkdir: vi.fn(async (p: string) => {
      if (!isOurs(p)) throw denied();
      owned.add(p);
    }),
    rm: vi.fn(async () => {}),
    transferIn: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as CommandExecutor;

  return { executor, commands };
}

function staticDeployConfig() {
  return {
    projectId: "proj_1",
    deploymentId: "dep_1",
    imageRef: BUILD_DIR,
    outputDirectory: "",
  } as unknown as Parameters<BareRuntime["deployStatic"]>[0];
}

describe("issue #514 — static deploy to a remote SSH server as a non-root user", () => {
  it("promotes the build into releases/ instead of failing with 'Permission denied'", async () => {
    const { executor, commands } = remoteNonRootServer();
    const rt = new BareRuntime({ workDir: STATIC_RELEASE_BASE, executor });

    await expect(rt.deployStatic(staticDeployConfig())).resolves.toMatchObject({
      status: "running",
      containerId: RELEASE_DIR,
    });

    // The release base was provisioned under sudo and handed to the deploy user…
    expect(
      commands.some(
        (c) => c.startsWith("sudo -n ") && c.includes(`${STATIC_RELEASE_BASE}/releases`),
      ),
    ).toBe(true);
    // …and the promote journaled into the USER's home, never /root.
    expect(commands.some((c) => c.includes(`${HOME}/.openship`))).toBe(true);
    expect(commands.some((c) => c.includes("/root/.openship"))).toBe(false);
    // The wrapper write is the operation that used to throw. Assert it actually
    // happened, so this stays a test about the mechanism and not just the path
    // string: with the base unfixed, this SFTP write is where the deploy died.
    expect(executor.writeFile).toHaveBeenCalledWith(
      `${HOME}/.openship/bin/opsh-run.tmp`,
      expect.stringContaining("OPSH"),
    );
  });
});
