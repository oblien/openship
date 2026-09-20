import { describe, expect, it } from "vitest";

import { OS_RELEASE, probeOutput } from "../system/environment.fixtures";
import { installTool } from "./installer";
import type { CommandExecutor } from "../types";

/**
 * Privilege for toolchain installs.
 *
 * A language runtime install writes where the login user cannot: a package manager needs
 * the dpkg/rpm lock, and every tarball recipe links a binary into /usr/local/bin. These
 * ran on the raw executor, so on a host reached as a non-root user every one of them
 * failed — reported as "install failed", never as "this login isn't privileged", which is
 * the half that made it unfixable from the UI.
 *
 * The verify is the mirror-image half: it must NOT be elevated, because the tool has to
 * be on PATH for whoever actually builds with it. Verifying as root would pass on a
 * $HOME recipe whose payload landed in /root, and the build would then fail instead.
 */
function fakeHost(probe: string) {
  const commands: string[] = [];
  const streamed: string[] = [];

  const executor = {
    exec: async (command: string) => {
      commands.push(command);
      return command.includes("opsh_begin") ? probe : "1.2.3";
    },
    streamExec: async (command: string) => {
      streamed.push(command);
      return { code: 0, output: "" };
    },
    writeFile: async () => {},
  } as unknown as CommandExecutor;

  // The probe carries a `sudo -n true` of its own, so a bare "no sudo anywhere"
  // assertion over every command would always fail.
  const ran = () => commands.filter((c) => !c.includes("opsh_begin"));

  return { executor, streamed, ran };
}

const ROOT = probeOutput({ osRelease: OS_RELEASE.ubuntu2404 });
const NON_ROOT_SUDO = probeOutput({
  osRelease: OS_RELEASE.ubuntu2404,
  uid: "1000",
  user: "deploy",
  home: "/home/deploy",
  sudo: "y",
});
const NON_ROOT_NO_SUDO = probeOutput({
  osRelease: OS_RELEASE.ubuntu2404,
  uid: "1000",
  user: "deploy",
  home: "/home/deploy",
  sudo: "n",
});
const MACOS = probeOutput({
  os: "Darwin",
  osRelease: null,
  pm: "brew",
  sm: "launchd",
  uid: "501",
  user: "dev",
  home: "/Users/dev",
});

describe("toolchain installer privilege", () => {
  // Bun is the recipe that proves one flag could never have described this: it downloads
  // into the login user's own home and then links the result into /usr/local/bin. Whichever
  // way a single `privileged` boolean was set, one of the two halves was wrong — elevate
  // both and root owns ~/.bun (a green install whose first `bun install` fails EACCES,
  // because verify only reads); elevate neither and the symlink is EPERM.
  it("elevates only the steps that write outside the login user's home", async () => {
    const { executor, streamed, ran } = fakeHost(NON_ROOT_SUDO);

    const result = await installTool(executor, "bun");
    expect(result.success).toBe(true);

    // Selected by content, not position: the recipe gained an unzip prerequisite and will
    // gain others, and a positional read turns that into a failure in the wrong assertion.
    const download = streamed.find((c) => c.includes("bun.sh/install"));
    const link = streamed.find((c) => c.includes("/usr/local/bin/bun"));
    expect(download).toBeDefined();
    expect(link).toBeDefined();

    expect(download).toContain("bun.sh/install");
    expect(download).not.toContain("sudo");
    // The payload goes to the login user's home, not sudo's rewritten /root — a 0700
    // /root is unreachable for the build user, so the symlink would dangle for them.
    expect(download).toMatch(/HOME='\/home\/deploy'/);
    expect(download).not.toContain("/root/.bun");

    expect(link).toContain("sudo -n sh -c");
    expect(link).toContain("/usr/local/bin/bun");

    // The "only" in the title, made mechanical: the download is the sole unelevated step,
    // so a new step added without deciding its privilege fails here rather than on a host.
    expect(streamed.filter((c) => !c.includes("sudo -n sh -c"))).toEqual([download]);

    const verify = ran().find((c) => c.includes("bun --version"));
    expect(verify).toBeDefined();
    expect(verify).not.toContain("sudo");
  });

  it("refuses with the fix when the login is measurably unprivileged", async () => {
    const { executor, streamed } = fakeHost(NON_ROOT_NO_SUDO);

    const result = await installTool(executor, "bun");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/passwordless sudo/);
    // And the install is not attempted anyway, which is what turned a diagnosable
    // refusal into an opaque exit code.
    expect(streamed).toEqual([]);
  });

  it("leaves a root login exactly as it was", async () => {
    const { executor, streamed, ran } = fakeHost(ROOT);

    expect((await installTool(executor, "bun")).success).toBe(true);
    expect(streamed.some((c) => c.includes("sudo"))).toBe(false);
    expect(ran().some((c) => c.includes("sudo"))).toBe(false);
  });

  it("never elevates on macOS, where Homebrew refuses to run under sudo", async () => {
    const { executor, streamed } = fakeHost(MACOS);

    expect((await installTool(executor, "node")).success).toBe(true);
    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toContain("brew install");
    // The operator's own machine, and a non-root uid: the one host where elevating
    // would turn a working install into an error.
    expect(streamed[0]).not.toContain("sudo");
  });
});

describe("toolchain installer version floor", () => {
  // The stack's floor arrived as `requiredVersion` and was then read by nothing, so a
  // distro package a major behind it — Alpine's nodejs 18 against a stack asking for 20.9
  // — was reported as a successful install. The build then failed on syntax the runtime
  // did not have, at a step that had no idea a version had been checked and passed.
  it("fails an install whose version is below the floor the stack asked for", async () => {
    const { executor } = fakeHost(ROOT);

    const result = await installTool(executor, "node", undefined, "20.9.0");

    expect(result.success).toBe(false);
    expect(result.error).toContain("1.2.3");
    expect(result.error).toContain("20.9.0");
  });

  it("accepts one that meets it", async () => {
    const { executor } = fakeHost(ROOT);

    expect((await installTool(executor, "node", undefined, "1.0.0")).success).toBe(true);
  });
});
