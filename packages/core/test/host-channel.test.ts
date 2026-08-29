import { describe, expect, it } from "vitest";
import {
  explainHostChannelCause,
  hostChannelAccount,
  HOST_CHANNEL_DEFAULT_ACCOUNT,
  hostFirewallRule,
  hostFirewallRuleRemoval,
  SSHD_ENABLE_HINT_UNKNOWN,
  wrapText,
  HOST_CHANNEL_NOT_PROVISIONED,
  HOST_CHANNEL_OPT_OUT,
  HOST_CHANNEL_PROVISION_COMMAND,
  HOST_CHANNEL_RECHECK,
  HOST_CHANNEL_RECHECK_COMMAND,
  HOST_CHANNEL_UNPROVISIONED,
  type HostChannelCause,
} from "../src/index";

/**
 * This module is the single source of truth for five surfaces (CLI preflight, API boot
 * banner, `openship doctor`, the dashboard banner, the deploy log), and it had no tests
 * at all. What's pinned here is the two properties the module's own comments claim and
 * nothing enforced — the properties whose failure is silent:
 *
 *   - every command in this prose survives being wrapped to a terminal, because a
 *     command broken across two lines is a command an operator can't copy;
 *   - a firewall rule is offered ONLY for the fault a firewall causes.
 */

/** A line with an odd number of backticks ends mid-command. */
const splitsACommand = (lines: readonly string[]) =>
  lines.filter((l) => (l.match(/`/g)?.length ?? 0) % 2 === 1);

/**
 * The widths the surfaces actually wrap to: 84 (the CLI's `dimWrapped`, and the boot
 * banner's bullets) and 88 (`wrapText`'s default, which the banner uses for the hint,
 * the recheck and the opt-out).
 *
 * Deliberately not "every width". Greedy word-wrap can split a two-word quoted command
 * at SOME width for any sentence containing one — the existing opt-out and this remedy
 * both do, at different ones — so a claim of universal safety would be a test passing by
 * luck. What is checkable, and what a copy edit breaks, is the property at the widths in
 * use. A new surface that picks a different width belongs in this list.
 */
const WIDTHS = [84, 88] as const;

describe("copy that quotes a command survives wrapping", () => {
  const withCommands: Array<[string, string]> = [
    ["the unprovisioned remedy", HOST_CHANNEL_NOT_PROVISIONED],
    ["the recheck line", HOST_CHANNEL_RECHECK],
    ["the opt-out", HOST_CHANNEL_OPT_OUT],
    // The pairing every surface actually prints: observation then remedy, as one
    // paragraph. Wrapping the halves separately would hide a break at the seam.
    ["observation + remedy together", `${HOST_CHANNEL_UNPROVISIONED} ${HOST_CHANNEL_NOT_PROVISIONED}`],
  ];

  for (const [name, text] of withCommands) {
    it.each(WIDTHS)(`${name} at width %i`, (width) => {
      expect(splitsACommand(wrapText(text, width))).toEqual([]);
    });
  }
});

describe("the unprovisioned state names both halves of the remedy", () => {
  it("names what repairs it and what verifies the repair", () => {
    // #509's error text named only the repair. The repair runs on the host and the fault
    // is observed inside a container, so "did it work" is a separate question — and the
    // command that answers it has to be in the sentence that sends people to run it.
    expect(HOST_CHANNEL_NOT_PROVISIONED).toContain(HOST_CHANNEL_PROVISION_COMMAND);
    expect(HOST_CHANNEL_NOT_PROVISIONED).toContain(HOST_CHANNEL_RECHECK_COMMAND);
  });

  it("says nothing was dialed, so no surface can report a machine that failed to answer", () => {
    expect(HOST_CHANNEL_UNPROVISIONED).toMatch(/nothing has been dialed/i);
    // No address, no interpolation slot: there is no endpoint in this state, and the
    // #509 bug was a surface filling that gap with the wrong machine.
    expect(HOST_CHANNEL_UNPROVISIONED).not.toMatch(/\{|\d+\.\d+\.\d+\.\d+/);
  });
});

describe("only a dropped packet is firewall-shaped", () => {
  const ctx = { target: "root@host.docker.internal:22", host: "host.docker.internal" };

  it("offers a rule for a timeout — the SYN vanished into filter/INPUT", () => {
    expect(explainHostChannelCause("timeout", ctx).firewallShaped).toBe(true);
  });

  it.each<HostChannelCause>(["refused", "unresolved", "no_route", "error"])(
    "withholds a rule for %s, whose fix is not a packet filter",
    (cause) => {
      expect(explainHostChannelCause(cause, ctx).firewallShaped).toBe(false);
    },
  );

  it("keeps the rule out of the prose, so a wrapped hint never eats a command", () => {
    // hint and rule are separate fields precisely because prose is wrapped and commands
    // must not be; this is the property that lets a caller wrap one and not the other.
    const { headline, body } = explainHostChannelCause("timeout", ctx);
    expect(`${headline} ${body}`).not.toContain("ufw allow");
  });
});

describe("the rule an operator pastes", () => {
  it("falls back to Docker's default pool when the real bridge can't be read", () => {
    expect(hostFirewallRule("ufw", [], 22)).toContain("172.16.0.0/12");
    // Not 0.0.0.0/0: host-firewall.ts reads an empty cidr list as "from anywhere", and
    // this port is for the bridges, so the channel's fallback must be the pool.
    expect(hostFirewallRule("ufw", [], 22)).not.toContain("0.0.0.0");
  });

  it("offers EVERY manager when we couldn't look, each commented so the wrong one is inert", () => {
    const rule = hostFirewallRule("unknown", ["172.18.0.0/16"], 22);
    for (const manager of ["ufw", "firewalld", "nftables", "iptables"]) {
      expect(rule).toContain(`# ${manager}:`);
    }
    // Every non-comment line is a command; a bare manager name would be pasted as one.
    for (const line of rule.split("\n")) {
      if (!line.startsWith("#")) expect(line).toMatch(/^sudo /);
    }
  });

  it("warns that a raw iptables rule does not survive a reboot", () => {
    expect(hostFirewallRule("none", ["172.18.0.0/16"], 22)).toMatch(/reboot/i);
    expect(hostFirewallRule("iptables", ["172.18.0.0/16"], 22)).toMatch(/reboot/i);
  });

  it("keeps the reboot caveats in the blind offer, where they matter most", () => {
    // The offer used to render each manager's steps WITHOUT its caveat, so the two forms
    // that don't persist lost the warning for the one operator who has the least
    // information: the one whose firewall we could not read.
    const rule = hostFirewallRule("unknown", ["172.18.0.0/16"], 22, "rhel");
    expect(rule).toMatch(/nftables\.conf/);
    expect(rule).toContain("iptables-services");
    // And the two that do persist are not given a caveat they don't need.
    const upToUfw = rule.slice(rule.indexOf("# ufw:"), rule.indexOf("# nftables:"));
    expect(upToUfw).not.toMatch(/reboot/i);
  });

  it("names the persistence package of the family it is talking to", () => {
    // `iptables-persistent` is a Debian package name and was printed to every host,
    // including the RHEL boxes where installing it is a 404.
    expect(hostFirewallRule("none", [], 22, "debian")).toContain("iptables-persistent");
    expect(hostFirewallRule("none", [], 22, "debian")).not.toContain("iptables-services");
    expect(hostFirewallRule("none", [], 22, "rhel")).toContain("iptables-services");
    expect(hostFirewallRule("none", [], 22, "alpine")).toContain("rc-update add iptables");
    // No family given = the caller couldn't look, so name both rather than guess one.
    const blind = hostFirewallRule("none", [], 22);
    expect(blind).toContain("iptables-persistent");
    expect(blind).toContain("iptables-services");
  });

  it("renders an nftables rule with its own persistence caveat", () => {
    const rule = hostFirewallRule("nftables", ["172.18.0.0/16"], 22);
    expect(rule).toContain("sudo nft add rule inet filter input ip saddr 172.18.0.0/16 tcp dport 22 accept");
    expect(rule).toMatch(/nftables\.conf/);
  });

  it("takes any firewall the detector can report, on both the rule and its undo", () => {
    // The undo used to accept only ufw|firewalld while the rule accepted the full union,
    // so one profile-derived value could not be passed to both.
    for (const fw of ["ufw", "firewalld", "nftables", "iptables", "none", "unknown"] as const) {
      expect(hostFirewallRule(fw, ["172.18.0.0/16"], 22).length).toBeGreaterThan(0);
      expect(hostFirewallRuleRemoval(fw, ["172.18.0.0/16"], 22).length).toBeGreaterThan(0);
    }
  });

  it("explains an nftables undo instead of emitting a command that cannot exist", () => {
    // A rule is deleted by handle, and the handle only lives in the running ruleset.
    const undo = hostFirewallRuleRemoval("nftables", ["172.18.0.0/16"], 22);
    expect(undo).toMatch(/handle/);
    // Commented, so pasting the block runs nothing rather than something wrong.
    for (const line of undo.split("\n")) expect(line).toMatch(/^# /);
  });

  it("undoes ufw and firewalld with the same shapes it added them", () => {
    expect(hostFirewallRuleRemoval("ufw", ["172.18.0.0/16"], 22)).toBe(
      "sudo ufw delete allow from 172.18.0.0/16 to any port 22 proto tcp",
    );
    expect(hostFirewallRuleRemoval("firewalld", ["172.18.0.0/16"], 22)).toContain(
      "--remove-rich-rule=",
    );
    expect(hostFirewallRuleRemoval("iptables", ["172.18.0.0/16"], 22)).toContain("iptables -D INPUT");
  });
});

describe("the command that starts sshd is this host's, not Debian's", () => {
  const ctx = { target: "root@host.docker.internal:22" };

  it("prints the hint the caller measured", () => {
    const body = explainHostChannelCause("refused", {
      ...ctx,
      sshdEnableHint: "sudo rc-update add sshd default && sudo rc-service sshd start",
    }).body;
    expect(body).toContain("rc-service sshd start");
    expect(body).not.toContain("systemctl");
  });

  it("qualifies the unit name when no one could look", () => {
    // Still a command — a "your channel is down" message with no next step is useless —
    // but no longer an unqualified claim that this box's unit is called `ssh`.
    const body = explainHostChannelCause("refused", ctx).body;
    expect(body).toContain(SSHD_ENABLE_HINT_UNKNOWN);
    expect(body).toMatch(/sshd/);
  });
});

/**
 * One resolver, because five copies is what #527 was made of.
 *
 * The account was spelled independently in the adapters' dial (`hostChannelUser`), the
 * api's self-server row (`desiredSshUser`), and three places in the CLI's compose layer.
 * Nothing kept them equal, and the row is display-only — so when they diverged, the
 * dashboard showed `admin@<ip>` while the dial used `root@host.docker.internal`, and the
 * operator "corrected" an account the channel was never going to use.
 *
 * These tests pin the resolver's contract. The ratchet below pins the harder half: that
 * nobody re-introduces a local copy of it.
 */
describe("hostChannelAccount — the one place the channel account is decided", () => {
  it("uses what provisioning wrote", () => {
    expect(hostChannelAccount({ OPENSHIP_HOST_SSH_USER: "deploy" })).toBe("deploy");
  });

  it("defaults to root when nothing was provisioned", () => {
    expect(hostChannelAccount({})).toBe(HOST_CHANNEL_DEFAULT_ACCOUNT);
    expect(hostChannelAccount({ OPENSHIP_HOST_SSH_USER: undefined })).toBe("root");
  });

  it("treats a blank or whitespace value as unset, not as an empty username", () => {
    // `.env` round-trips can leave `OPENSHIP_HOST_SSH_USER=`; dialing "" fails with an
    // sshd error that names no account at all.
    expect(hostChannelAccount({ OPENSHIP_HOST_SSH_USER: "" })).toBe("root");
    expect(hostChannelAccount({ OPENSHIP_HOST_SSH_USER: "   " })).toBe("root");
  });

  it("trims, so a stray newline from a written .env cannot become part of the account", () => {
    expect(hostChannelAccount({ OPENSHIP_HOST_SSH_USER: " deploy\n" })).toBe("deploy");
  });

  it("answers identically for a live process env and a parsed .env record", () => {
    // The two callers read from different sources; the whole point is that the source
    // cannot change the answer.
    const parsed: Record<string, string> = { OPENSHIP_HOST_SSH_USER: "deploy" };
    const live: NodeJS.ProcessEnv = { OPENSHIP_HOST_SSH_USER: "deploy" };
    expect(hostChannelAccount(parsed)).toBe(hostChannelAccount(live));
  });
});
