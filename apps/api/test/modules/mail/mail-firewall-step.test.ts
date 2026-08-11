import "./_setup-env";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { EnvironmentProfile } from "@repo/adapters";

/**
 * Step 4 opens the inbound mail ports through the resolver's view of the host.
 *
 * The `ufw status | head -1` probe this replaced could only tell ufw from not-ufw, so a
 * firewalld box took the raw-`iptables` branch and got rules firewalld throws away at its
 * next reload — mail arrived until something reloaded, then stopped. And a box with no
 * firewall got eight INPUT ACCEPT rules for ports nothing was filtering.
 *
 * Only `resolveEnvironment` is mocked: `envOps`, `opScript` and the firewall tables are
 * the real ones, so these assertions are on the command this host would really get.
 */
const h = vi.hoisted(() => ({ host: {} as Partial<EnvironmentProfile> }));

vi.mock("@repo/adapters", async (importOriginal) => {
  const real = await importOriginal<typeof import("@repo/adapters")>();
  const fixtures = await import("../../../../../packages/adapters/src/system/environment.fixtures");
  return { ...real, resolveEnvironment: async () => fixtures.profileFixture(h.host) };
});

import { MAIL_PORTS } from "@repo/adapters";
import { stepOpenMailFirewall } from "../../../src/modules/mail/mail.service";

function fakeExecutor(fail?: (cmd: string) => string | undefined) {
  const commands: string[] = [];
  const exec = async (cmd: string) => {
    commands.push(cmd);
    const err = fail?.(cmd);
    if (err) throw new Error(err);
    return "";
  };
  return { commands, executor: { exec } as never };
}

function run(exec: unknown) {
  const logs: string[] = [];
  return stepOpenMailFirewall(exec as never, "mail.example.com", (_id, lvl, m) =>
    logs.push(`${lvl}: ${m}`),
  ).then((result) => ({ result, logs: logs.join("\n") }));
}

beforeEach(() => {
  h.host = {};
});

describe("stepOpenMailFirewall", () => {
  test("ufw box → one `ufw allow` per mail port, and nothing else", async () => {
    h.host = { firewall: "ufw" };
    const { executor, commands } = fakeExecutor();

    const { result } = await run(executor);

    expect(result.success).toBe(true);
    expect(commands).toEqual(MAIL_PORTS.map((p) => `ufw allow ${p}/tcp`));
  });

  test("firewalld box → firewall-cmd, NOT iptables (the branch that used to be taken)", async () => {
    h.host = {
      distro: "rocky",
      distroFamily: "rhel",
      distroId: "rocky",
      prettyName: "Rocky Linux 9.4 (Blue Onyx)",
      packageManager: "dnf",
      firewall: "firewalld",
    };
    const { executor, commands } = fakeExecutor();

    const { result } = await run(executor);

    expect(result.success).toBe(true);
    const all = commands.join("\n");
    expect(all).toContain("firewall-cmd --permanent --add-port=25/tcp");
    expect(all).toContain("firewall-cmd --reload");
    expect(all).not.toMatch(/iptables/);
    expect(all).not.toMatch(/\bufw\b/);
  });

  test("no active firewall → touches nothing and says so", async () => {
    h.host = { firewall: "none" };
    const { executor, commands } = fakeExecutor();

    const { result } = await run(executor);

    expect(result.success).toBe(true);
    expect(commands).toEqual([]);
    expect(result.message).toMatch(/No firewall/i);
  });

  test("an unreadable firewall warns; it does not read as 'nothing to open'", async () => {
    // `unknown` and `none` used to render the same success line — "No firewall to open on
    // this host" — for two opposite observations. On a box that does filter, that line is
    // a false all-clear, and mail silently never arrives.
    h.host = { firewall: "unknown" };
    const { executor, commands } = fakeExecutor();

    const { result, logs } = await run(executor);

    expect(commands).toEqual([]);
    expect(result.message).not.toMatch(/No firewall/i);
    expect(result.warning).toBeTruthy();
    expect(result.warning).toContain("25");
    expect(logs).toMatch(/^warn:/m);
  });

  test("raw iptables → refuses to add a rule that dies at reboot, and prints it", async () => {
    // The asymmetry this closes: `openship up` already refused an unpersisted rule while
    // this step applied one, so the same box got two answers about the same ruleset.
    h.host = { firewall: "iptables" };
    const { executor, commands } = fakeExecutor();

    const { result, logs } = await run(executor);

    expect(result.success).toBe(true);
    expect(commands).toEqual([]);
    expect(result.warning).toContain("were not opened");
    expect(logs).toContain("iptables -I INPUT -p tcp --dport 25 -j ACCEPT");
  });

  test("unsupported host → no commands, and the refusal names the distro", async () => {
    // ufw is present and drivable; the host is not one Openship provisions. `firewallAllow`
    // is gated on that, so the reason has to reach the operator instead of eight silent
    // no-ops that read as success.
    h.host = {
      distro: "opensuse",
      distroFamily: "suse",
      distroId: "opensuse-leap",
      prettyName: "openSUSE Leap 15.6",
      firewall: "ufw",
    };
    const { executor, commands } = fakeExecutor();

    const { result } = await run(executor);

    expect(commands).toEqual([]);
    expect(result.warning).toContain("opensuse-leap");
  });

  test("one rejected port is reported as itself; the rest still get opened", async () => {
    h.host = { firewall: "ufw" };
    const { executor, commands } = fakeExecutor((cmd) =>
      cmd.includes("4190/tcp") ? "ERROR: could not insert rule" : undefined,
    );

    const { result } = await run(executor);

    expect(commands).toHaveLength(MAIL_PORTS.length);
    expect(result.success).toBe(true);
    expect(result.warning).toContain("4190");
    expect(result.warning).toContain("could not insert rule");
  });

  test("a dropped connection aborts instead of failing seven more ports", async () => {
    h.host = { firewall: "ufw" };
    const { executor, commands } = fakeExecutor(() => "All configured authentication methods failed");

    await expect(run(executor)).rejects.toThrow(/authentication methods failed/);
    expect(commands).toHaveLength(1);
  });
});
