import { describe, expect, test } from "vitest";

import type { CommandExecutor } from "@repo/adapters";
import { provisionDomainDkim } from "@repo/platform/engine/modules/mail/mail.service";

const NON_ROOT_SUDO_PROFILE = [
  "opsh_begin=1",
  "opsh_os=Linux",
  "opsh_arch=x86_64",
  "opsh_uid=1000",
  "opsh_user=ubuntu",
  "opsh_home=/home/ubuntu",
  "opsh_osr:ID=ubuntu",
  'opsh_osr:VERSION_ID="24.04"',
  "opsh_pm=apt",
  "opsh_sm=systemd",
  "opsh_sudo=y",
  "opsh_fw=none",
  "opsh_libc=glibc",
  "opsh_selinux=absent",
  "opsh_container=n",
  "opsh_end=1",
].join("\n");

function containerMailExecutor() {
  const commands: string[] = [];
  const writes: { path: string; content: string; mode?: number }[] = [];
  const exec = {
    exec: async (command: string) => {
      if (command.includes('echo "opsh_begin=1"')) return NON_ROOT_SUDO_PROFILE;
      if (command.includes("docker inspect")) return "true\topenship/mail:test";
      commands.push(command);
      if (command.includes("command -v") && command.includes("bin=$b")) return "bin=amavisd\n";
      if (command.includes("sudo -n sh -c") && command.includes("cat ")) {
        return "# existing amavis configuration\n";
      }
      if (command.includes(" showkeys ")) return '"v=DKIM1; p=abc123"\n';
      return "";
    },
    streamExec: async () => ({ code: 0, output: "" }),
    writeFile: async (path: string, content: string, opts?: { mode?: number }) => {
      writes.push({ path, content, mode: opts?.mode });
    },
    readFile: async () => {
      throw new Error("EACCES: permission denied");
    },
    exists: async () => false,
    mkdir: async () => {},
    rm: async () => {},
  } as CommandExecutor;
  return { exec, commands, writes };
}

describe("root-owned mail configuration", () => {
  test("additional-domain DKIM uses sudo for host files and the login Docker context for engine commands", async () => {
    const { exec, commands, writes } = containerMailExecutor();

    await expect(provisionDomainDkim(exec, "new.example.com")).resolves.toBe("v=DKIM1;p=abc123");

    const dockerCommands = commands.filter((command) =>
      command.includes("docker exec openship-mail"),
    );
    expect(dockerCommands.length).toBeGreaterThan(0);
    expect(dockerCommands.every((command) => command.startsWith("docker exec openship-mail"))).toBe(
      true,
    );
    expect(commands.some((command) => command.startsWith("sudo -n sh -c"))).toBe(true);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      path: expect.stringMatching(/^\/tmp\/\.openship-elev-[0-9a-f]{24}\/payload$/),
      content: expect.stringContaining("dkim_key('new.example.com'"),
      mode: 0o644,
    });
    // Config content stays on the file channel; only fixed paths and daemon
    // commands are visible in argv/process listings.
    expect(commands.join("\n")).not.toContain("dkim_key('new.example.com'");
  });
});
