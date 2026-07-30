import "./_setup-env";
import { describe, expect, test, vi } from "vitest";

/**
 * The vendored engine's `pkgs/get_all.sh` asks l.iredmail.org whether its
 * PROG_VERSION is current and `exit 255`s when upstream says no — which, for a
 * pinned in-repo engine, is always. Step 9 must keep passing the engine's own
 * opt-out on the installer command line.
 */
vi.mock("./mail-credentials.service", () => ({
  updatePostmasterPassword: vi.fn(async () => undefined),
}));

import { stepRunInstaller } from "../../../src/modules/mail/mail.service";

/** Nothing installed yet, every command succeeds, installer command captured. */
function installerExecutor() {
  const streamed: string[] = [];
  const executor = {
    exec: async () => "missing\n",
    writeFile: async () => undefined,
    streamExec: async (command: string) => {
      streamed.push(command);
      return { code: 0, output: "" };
    },
  } as never;
  return { executor, streamed };
}

describe("step 9 installer invocation", () => {
  test("opts out of the engine's upstream version check", async () => {
    const { executor, streamed } = installerExecutor();

    await stepRunInstaller(executor, "example.com", () => {});

    const installerCmd = streamed.find((c) => c.includes("iRedMail.sh"));
    expect(installerCmd).toBeDefined();
    expect(installerCmd).toContain("CHECK_NEW_IREDMAIL=NO");
    // The opt-out has to be part of the env PREFIX on the same line as the
    // sub-bash, not a shell-local assignment the installer never sees.
    expect(installerCmd).toMatch(/CHECK_NEW_IREDMAIL=NO[^&|;]*bash iRedMail\.sh/);
  });

  test("still short-circuits the interactive prompts", async () => {
    const { executor, streamed } = installerExecutor();

    await stepRunInstaller(executor, "example.com", () => {});

    const installerCmd = streamed.find((c) => c.includes("iRedMail.sh"))!;
    expect(installerCmd).toContain("AUTO_INSTALL_WITHOUT_CONFIRM=y");
    expect(installerCmd).toContain("AUTO_USE_EXISTING_CONFIG_FILE=y");
  });
});
