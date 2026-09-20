import { describe, it, expect, vi } from "vitest";
import { HOST_CHANNEL_BLOCKED, HOST_CHANNEL_UNAFFECTED } from "@repo/core";
import {
  checkHostChannel,
  verifyHostChannel,
  type HostChannelPreflightDeps,
  type ProbeResult,
} from "../../src/lib/host-channel-preflight";
import { hostControlRow } from "../../src/lib/repair";

/**
 * #490: `openship up --compose` provisions a container→host SSH channel and never
 * dials it. On a default-deny host the channel is dead and the install still
 * reports success, so every host operation afterwards fails looking exactly like a
 * bad key. These tests pin the two properties that make the preflight worth having:
 * it must diagnose the RIGHT cause, and it must never claim a fix it didn't verify.
 */

const CHANNEL = { host: "host.docker.internal", port: 22, user: "root" };

function deps(over: Partial<HostChannelPreflightDeps> = {}): HostChannelPreflightDeps {
  return {
    platform: "linux",
    interactive: true,
    channel: vi.fn(() => CHANNEL),
    // Only consulted when `channel()` is null; never left to the real reader, which
    // would put a test at the mercy of whatever is in this machine's ~/.openship.
    expected: vi.fn(() => false),
    probe: vi.fn(async (): Promise<ProbeResult> => ({ code: "open" })),
    sourceCidrs: vi.fn(() => ["172.18.0.0/16"]),
    firewall: vi.fn(() => "ufw" as const),
    // A named box, not a global default: the sshd unit is `ssh` here because this
    // fixture is Debian-family, and the assertions below say so about THIS host rather
    // than about every host — which is the claim the copy used to make.
    distroFamily: vi.fn(() => "debian" as const),
    sshdEnableHint: vi.fn(() => "sudo systemctl enable --now ssh"),
    applyRule: vi.fn(() => ({ ok: true })),
    confirmOpen: vi.fn(async () => true),
    print: vi.fn(),
    ...over,
  };
}

/** A host that was firewalled and, once the rule lands, isn't. */
function blockedThenOpen() {
  return vi
    .fn<(h: string, p: number) => Promise<ProbeResult>>()
    .mockResolvedValueOnce({ code: "timeout" })
    .mockResolvedValue({ code: "open" });
}

/** Everything printed across the run, stripped of ANSI, as one string. */
function output(d: HostChannelPreflightDeps): string {
  return vi
    .mocked(d.print)
    .mock.calls.map(([t]) => t)
    .join("\n")
    .replace(new RegExp("\\u001b\\[[0-9;]*m", "g"), "");
}

describe("verifyHostChannel", () => {
  it("does nothing on a non-Linux host", async () => {
    const d = deps({ platform: "darwin" });
    expect(await verifyHostChannel({}, d)).toEqual({ status: "skipped" });
    expect(d.probe).not.toHaveBeenCalled();
  });

  it("does nothing when this box wanted no host channel", async () => {
    // A bare install or `--no-host-control`. Not a fault, so not a warning.
    const d = deps({ channel: vi.fn(() => null), expected: vi.fn(() => false) });
    expect(await verifyHostChannel({}, d)).toEqual({ status: "skipped" });
    expect(d.probe).not.toHaveBeenCalled();
    expect(d.print).not.toHaveBeenCalled();
  });

  /**
   * #509. This case used to return `skipped` and print nothing, on the reasoning that a
   * null channel means nobody wanted one. On a compose install that is false: nobody
   * DECLINED it, `provisionHostSshChannel` failed — at the time, without a word — so `up`
   * reported success on a box where every host operation was already dead, and the
   * operator found out at the first catalog-app deploy days later.
   *
   * Provisioning now names the cause as it fails (`renderHostChannelIssue` in compose.ts).
   * This surface is still the one that reports the STATE, on this run and on every later
   * one, after that line has scrolled away.
   */
  it("reports an install that wanted a channel and hasn't got one", async () => {
    const d = deps({ channel: vi.fn(() => null), expected: vi.fn(() => true) });
    expect(await verifyHostChannel({}, d)).toEqual({ status: "unprovisioned" });
    // Nothing to dial, so nothing is dialed — and no firewall is touched or offered.
    expect(d.probe).not.toHaveBeenCalled();
    expect(d.firewall).not.toHaveBeenCalled();
    expect(d.applyRule).not.toHaveBeenCalled();
    const out = output(d);
    expect(out).toContain("not provisioned");
    expect(out).toContain("openship up");
    expect(out).not.toContain("ufw");
  });

  it("keeps the unprovisioned install legible as degraded, not broken", async () => {
    const d = deps({ channel: vi.fn(() => null), expected: vi.fn(() => true) });
    await verifyHostChannel({}, d);
    const out = output(d);
    // The same reassurance + blocked list every other surface prints, so an operator
    // reading this one doesn't conclude the box is down.
    expect(out).toContain(HOST_CHANNEL_UNAFFECTED);
    for (const item of HOST_CHANNEL_BLOCKED) expect(out).toContain(item);
    // Fix before opt-out, as everywhere else: the fastest way to silence the warning
    // must not be the first thing on the screen.
    expect(out.indexOf("openship up")).toBeLessThan(out.indexOf("--no-host-control"));
  });

  it("reports ok and stays silent when the channel answers", async () => {
    const d = deps();
    expect(await verifyHostChannel({}, d)).toEqual({ status: "ok", code: "open" });
    expect(d.print).not.toHaveBeenCalled();
    expect(d.firewall).not.toHaveBeenCalled();
  });

  it("probes from the container using the address the install was CONFIGURED with", async () => {
    // Not the planned address: the preflight's whole job is verifying what got
    // written to `.env`, so a channel on a non-default port must be probed there.
    const d = deps({ channel: vi.fn(() => ({ host: "10.0.0.1", port: 2222, user: "ops" })) });
    await verifyHostChannel({}, d);
    expect(d.probe).toHaveBeenCalledWith("10.0.0.1", 2222);
  });
});

describe("a dropped SYN is diagnosed as the firewall", () => {
  it("names the firewall, scopes the rule to the container subnet, and offers it", async () => {
    const d = deps({ probe: blockedThenOpen() });
    const report = await verifyHostChannel({}, d);

    expect(report.status).toBe("fixed");
    expect(d.applyRule).toHaveBeenCalledWith("ufw", ["172.18.0.0/16"], 22);
    // The rule must be the narrow one, not "allow 22 from anywhere".
    expect(report.rule).toBe("sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp");
    const out = output(d);
    expect(out).toContain("INPUT chain");
    // And it has to say what still works, or an operator reads this as a broken install.
    expect(out).toContain("deploys to this box still work");
  });

  it("falls back to docker's pool — and says so — when the subnet can't be read", async () => {
    const d = deps({
      probe: vi.fn(async () => ({ code: "timeout" as const })),
      sourceCidrs: vi.fn(() => []),
    });
    const report = await verifyHostChannel({}, d);
    expect(report.rule).toContain("172.16.0.0/12");
    expect(output(d)).toContain("the exact subnet couldn't be read");
  });

  it("builds a reloading, reboot-surviving rule for firewalld", async () => {
    const d = deps({
      probe: vi.fn(async () => ({ code: "timeout" as const })),
      firewall: vi.fn(() => "firewalld" as const),
    });
    const report = await verifyHostChannel({}, d);
    expect(report.rule).toContain("--permanent --add-rich-rule=");
    expect(report.rule).toContain("firewall-cmd --reload");
  });
});

describe("consent gates the host mutation", () => {
  it("never applies a rule without consent, and leaves the operator the command", async () => {
    const d = deps({
      probe: vi.fn(async () => ({ code: "timeout" as const })),
      confirmOpen: vi.fn(async () => false),
    });
    const report = await verifyHostChannel({}, d);
    expect(d.applyRule).not.toHaveBeenCalled();
    expect(report.status).toBe("blocked");
    expect(report.rule).toContain("ufw allow from");
  });

  it("does not prompt — or apply — when non-interactive without the flag", async () => {
    // `--yes` must not carry consent to edit the host's firewall, so a headless run
    // with no explicit opt-in reports and moves on.
    const d = deps({
      interactive: false,
      probe: vi.fn(async () => ({ code: "timeout" as const })),
    });
    const report = await verifyHostChannel({}, d);
    expect(d.confirmOpen).not.toHaveBeenCalled();
    expect(d.applyRule).not.toHaveBeenCalled();
    expect(report.status).toBe("blocked");
    expect(output(d)).toContain("--open-host-firewall");
  });

  it("applies without prompting when --open-host-firewall was passed", async () => {
    const d = deps({ interactive: false, probe: blockedThenOpen() });
    const report = await verifyHostChannel({ openFirewall: true }, d);
    expect(d.confirmOpen).not.toHaveBeenCalled();
    expect(d.applyRule).toHaveBeenCalled();
    expect(report.status).toBe("fixed");
  });

  it("won't apply a rule that wouldn't survive a reboot", async () => {
    // Plain iptables — the RHEL-family default, and the case that used to reach here as
    // `null`. A rule we add lives in the running ruleset only, so it vanishes at the next
    // reboot: worse than one the operator installed knowing where it lives.
    const d = deps({
      probe: vi.fn(async () => ({ code: "timeout" as const })),
      firewall: vi.fn(() => "iptables" as const),
      distroFamily: vi.fn(() => "rhel" as const),
    });
    const report = await verifyHostChannel({ openFirewall: true }, d);
    expect(d.applyRule).not.toHaveBeenCalled();
    expect(report.status).toBe("blocked");
    expect(report.rule).toContain("iptables -I INPUT");
    expect(output(d)).toContain("survive a reboot");
    // The persistence package of the family we measured, not Debian's — installing
    // `iptables-persistent` on a RHEL box is a 404.
    expect(output(d)).toContain("iptables-services");
    expect(output(d)).not.toContain("iptables-persistent");
  });

  it("won't apply an nftables rule either, and says why the undo isn't a command", async () => {
    const d = deps({
      probe: vi.fn(async () => ({ code: "timeout" as const })),
      firewall: vi.fn(() => "nftables" as const),
    });
    const report = await verifyHostChannel({ openFirewall: true }, d);
    expect(d.applyRule).not.toHaveBeenCalled();
    expect(report.status).toBe("blocked");
    expect(report.rule).toContain("nft add rule inet filter input");
    expect(output(d)).toContain("survive a reboot");
  });

  /**
   * The two answers that are about LOOKING, not about a manager — and which the old
   * `ufw|firewalld|null` detection collapsed into one. They must not read the same: a box
   * with nothing enforcing has no rule to add, while a box we couldn't measure has a rule
   * we refuse to guess at, and the next place to look differs.
   */
  it("distinguishes 'nothing is enforcing' from 'we couldn't tell'", async () => {
    const nothing = deps({
      probe: vi.fn(async () => ({ code: "timeout" as const })),
      firewall: vi.fn(() => "none" as const),
    });
    await verifyHostChannel({ openFirewall: true }, nothing);
    expect(nothing.applyRule).not.toHaveBeenCalled();
    // Nothing is filtering, so the SYN died somewhere else — a security group, an ACL.
    expect(output(nothing).replace(/\s+/g, " ")).toContain("security group");

    const blind = deps({
      probe: vi.fn(async () => ({ code: "timeout" as const })),
      firewall: vi.fn(() => "unknown" as const),
    });
    const report = await verifyHostChannel({ openFirewall: true }, blind);
    expect(blind.applyRule).not.toHaveBeenCalled();
    expect(output(blind).replace(/\s+/g, " ")).toContain("could not determine which firewall");
    // Every form offered, each commented, so the wrong one is inert when pasted.
    for (const manager of ["ufw", "firewalld", "nftables", "iptables"]) {
      expect(report.rule).toContain(`# ${manager}:`);
    }
  });
});

describe("the outcome reported is the one that was measured", () => {
  it("re-probes after applying, and reports blocked when the rule didn't help", async () => {
    // The regression this guards: `ufw allow` exiting 0 is not the channel working.
    // A second docker network, a DOCKER-USER rule ahead of ufw, or sshd on loopback
    // all leave it dead — and calling that "fixed" is #490 wearing a fix.
    const probe = vi
      .fn<(h: string, p: number) => Promise<ProbeResult>>()
      .mockResolvedValueOnce({ code: "timeout" })
      .mockResolvedValueOnce({ code: "timeout" });
    const d = deps({ probe });
    const report = await verifyHostChannel({ openFirewall: true }, d);

    expect(probe).toHaveBeenCalledTimes(2);
    expect(report.status).toBe("blocked");
    expect(output(d)).toContain("DOCKER-USER");
  });

  it("re-diagnoses when the rule changed the failure, instead of blaming DOCKER-USER", async () => {
    // The rule worked — the SYN now reaches the host — and sshd is the one refusing.
    // Reporting the pre-rule cause here sends an operator to read iptables over a
    // service that isn't listening.
    const probe = vi
      .fn<(h: string, p: number) => Promise<ProbeResult>>()
      .mockResolvedValueOnce({ code: "timeout" })
      .mockResolvedValueOnce({ code: "refused" });
    const d = deps({ probe });
    const report = await verifyHostChannel({ openFirewall: true }, d);

    expect(report).toMatchObject({ status: "blocked", code: "refused" });
    const out = output(d);
    expect(out).toContain("ListenAddress");
    expect(out).not.toContain("DOCKER-USER");
  });

  it("discloses the rule it left behind, with the command to undo it", async () => {
    // Consent was given on the premise that this rule was the blocker. It wasn't, so
    // the host change can't be left invisible — but it isn't undone for the operator
    // either: it may be needed once the real cause is fixed.
    const d = deps({ probe: vi.fn(async () => ({ code: "timeout" as const })) });
    await verifyHostChannel({ openFirewall: true }, d);
    expect(output(d)).toContain("sudo ufw delete allow from 172.18.0.0/16 to any port 22 proto tcp");
  });

  it("undoes a firewalld rich rule with the reload it needs", async () => {
    const d = deps({
      probe: vi.fn(async () => ({ code: "timeout" as const })),
      firewall: vi.fn(() => "firewalld" as const),
    });
    await verifyHostChannel({ openFirewall: true }, d);
    const out = output(d);
    expect(out).toContain("--permanent --remove-rich-rule=");
    expect(out).toContain("firewall-cmd --reload");
  });

  it("reports blocked when the rule itself fails to apply", async () => {
    const d = deps({
      probe: vi.fn(async () => ({ code: "timeout" as const })),
      applyRule: vi.fn(() => ({ ok: false, detail: "sudo: a password is required" })),
    });
    const report = await verifyHostChannel({ openFirewall: true }, d);
    expect(report.status).toBe("blocked");
    expect(output(d)).toContain("a password is required");
    // One probe only: there's nothing new to measure.
    expect(d.probe).toHaveBeenCalledTimes(1);
  });
});

describe("failures that are not the firewall are not treated as one", () => {
  it("sends a refused connection to sshd, not to ufw", async () => {
    const d = deps({ probe: vi.fn(async () => ({ code: "refused" as const })) });
    const report = await verifyHostChannel({ openFirewall: true }, d);
    expect(report).toEqual({ status: "blocked", code: "refused" });
    expect(d.firewall).not.toHaveBeenCalled();
    expect(d.applyRule).not.toHaveBeenCalled();
    const out = output(d);
    expect(out).toContain("systemctl enable --now ssh");
    expect(out).toContain("ListenAddress");
  });

  it("names the sshd command THIS host answers to, not Debian's", async () => {
    // The remedy was `systemctl enable --now ssh` for every box. On the RHEL family the
    // unit is `sshd` and on Alpine there is no systemctl at all, so the one command the
    // operator was handed did nothing on exactly the hosts most likely to be reading it.
    const d = deps({
      probe: vi.fn(async () => ({ code: "refused" as const })),
      sshdEnableHint: vi.fn(() => "sudo rc-update add sshd default && sudo rc-service sshd start"),
    });
    await verifyHostChannel({ openFirewall: true }, d);
    const out = output(d);
    expect(out).toContain("rc-service sshd start");
    expect(out).not.toContain("systemctl");
  });

  it("sends an unresolved host.docker.internal to the Docker version, not to ufw", async () => {
    const d = deps({ probe: vi.fn(async () => ({ code: "unresolved" as const })) });
    const report = await verifyHostChannel({ openFirewall: true }, d);
    expect(report.status).toBe("blocked");
    expect(d.applyRule).not.toHaveBeenCalled();
    expect(output(d)).toContain("host-gateway");
  });

  it("does not claim blocked when the probe could not be RUN at all", async () => {
    // `docker exec` failing for its own reasons must not send anyone to edit a
    // firewall. Neither outcome was measured, so neither is reported.
    const d = deps({
      probe: vi.fn(async () => ({ code: "unavailable" as const, detail: "no such service: api" })),
    });
    const report = await verifyHostChannel({ openFirewall: true }, d);
    expect(report).toEqual({ status: "skipped", code: "unavailable" });
    expect(d.applyRule).not.toHaveBeenCalled();
    expect(output(d)).toContain("no such service: api");
  });
});

/**
 * Five different failures leave the channel blocked, and each used to end with its own
 * ad-hoc footer: some named `openship doctor`, some named `--no-host-control`, none
 * named both. The one that mattered least — the switch that turns the feature off —
 * was the last word on the paths an operator is most likely to hit.
 */
describe("what a blocked exit leaves the operator with", () => {
  const EXITS: Array<[string, Partial<HostChannelPreflightDeps>]> = [
    ["the failure isn't the firewall's shape", { probe: vi.fn(async () => ({ code: "refused" as const })) }],
    ["there's no manager whose rule would persist", { firewall: vi.fn(() => "iptables" as const) }],
    ["nothing is enforcing at all", { firewall: vi.fn(() => "none" as const) }],
    ["we couldn't tell which firewall this is", { firewall: vi.fn(() => "unknown" as const) }],
    ["consent was withheld", { confirmOpen: vi.fn(async () => false) }],
    ["the rule wouldn't apply", { applyRule: vi.fn(() => ({ ok: false, detail: "sudo: a password is required" })) }],
    ["the rule applied and didn't help", {}],
  ];

  it.each(EXITS)("names both the re-check and the opt-out when %s", async (_why, over) => {
    const d = deps({ probe: vi.fn(async () => ({ code: "timeout" as const })), ...over });
    const report = await verifyHostChannel({ openFirewall: true }, d);
    expect(report.status).toBe("blocked");
    const out = output(d);
    expect(out).toContain("openship doctor");
    expect(out).toContain("--no-host-control");
  });

  it("says the opt-out is not a fix, and that the losses stay", async () => {
    // Without this the fastest way to clear the warning is to switch host control off,
    // and nothing on screen says the host terminal stays gone. Matched against
    // whitespace-collapsed output: the sentence is wrapped to the terminal, so where
    // the line breaks fall is layout, not copy.
    const d = deps({ probe: vi.fn(async () => ({ code: "timeout" as const })) });
    await verifyHostChannel({}, d);
    const prose = output(d).replace(/\s+/g, " ");
    expect(prose).toContain("Not a fix, a choice");
    expect(prose).toContain("the items above stay unavailable");
  });

  it("prints the fix BEFORE the opt-out", async () => {
    const d = deps({ probe: vi.fn(async () => ({ code: "timeout" as const })) });
    await verifyHostChannel({}, d);
    const out = output(d);
    expect(out.indexOf("ufw allow from")).toBeLessThan(out.indexOf("--no-host-control"));
  });

  it("does not offer the opt-out as the answer to an old Docker", async () => {
    // `host-gateway` needs Docker 20.10+. Turning the channel off doesn't upgrade
    // Docker; it just makes the paragraph above stop applying.
    const d = deps({ probe: vi.fn(async () => ({ code: "unresolved" as const })) });
    await verifyHostChannel({}, d);
    // Collapsed: the paragraph is wrapped to the terminal, so where "Docker 20.10+"
    // breaks is layout, not copy.
    const diagnosis = output(d).split("Not a fix")[0]!.replace(/\s+/g, " ");
    expect(diagnosis).toContain("Docker 20.10+");
    expect(diagnosis).not.toContain("--no-host-control");
  });
});

/**
 * The install-time preflight runs once and tells the operator to come back to
 * `openship doctor`. That promise is only worth anything if doctor asks the same
 * question the same way, so these pin the read-only half against the same deps —
 * and pin that it stays read-only: a health readout that edits the host firewall
 * while someone is looking at a status list would be its own incident.
 */
describe("checkHostChannel — the read-only probe doctor uses", () => {
  it("reports the target and the code it measured, and mutates nothing", async () => {
    const d = deps({ probe: vi.fn(async () => ({ code: "timeout" as const })) });
    expect(await checkHostChannel(d)).toEqual({
      configured: true,
      target: "host.docker.internal:22",
      code: "timeout",
      detail: undefined,
    });
    expect(d.applyRule).not.toHaveBeenCalled();
    expect(d.confirmOpen).not.toHaveBeenCalled();
    expect(d.print).not.toHaveBeenCalled();
  });

  it("keeps the raw errno for the operator", async () => {
    const d = deps({ probe: vi.fn(async () => ({ code: "error" as const, detail: "EHOSTUNREACH" })) });
    expect(await checkHostChannel(d)).toMatchObject({ code: "error", detail: "EHOSTUNREACH" });
  });

  it("says 'nothing configured' rather than probing, when there's no channel", async () => {
    const d = deps({ channel: vi.fn(() => null), expected: vi.fn(() => false) });
    expect(await checkHostChannel(d)).toEqual({ configured: false, unprovisioned: false });
    expect(d.probe).not.toHaveBeenCalled();
  });

  it("doesn't even ask on a non-Linux box — there is no channel to want", async () => {
    const d = deps({ platform: "darwin" });
    expect(await checkHostChannel(d)).toEqual({ configured: false });
    expect(d.probe).not.toHaveBeenCalled();
    expect(d.expected).not.toHaveBeenCalled();
  });

  /** #509: doctor is the command the host-op failure tells operators to run, so this
   *  state has to reach it — as a fault, distinguishable from "no channel wanted". */
  it("distinguishes a channel that failed to provision from one nobody wanted", async () => {
    const d = deps({ channel: vi.fn(() => null), expected: vi.fn(() => true) });
    expect(await checkHostChannel(d)).toEqual({ configured: false, unprovisioned: true });
    expect(d.probe).not.toHaveBeenCalled();
    expect(d.print).not.toHaveBeenCalled();
  });
});

describe("the doctor row", () => {
  it("is absent when this box wanted no channel", async () => {
    // A row about a channel nobody wanted is noise on every bare install and every
    // mac, and a `fail` there would make `openship doctor` exit 1 for nothing.
    expect(hostControlRow({ configured: false })).toBeNull();
    expect(hostControlRow({ configured: false, unprovisioned: false })).toBeNull();
    expect(hostControlRow(null)).toBeNull();
  });

  /**
   * #509 closed its remedy loop the wrong way round: the error an operator reads when a
   * host operation dies names `openship doctor` as the way to check this, and doctor
   * printed NO row for the state that produces that error. A channel that was never
   * provisioned is exactly as broken as one that's firewalled off.
   */
  it("fails a channel this install wanted and never got, and names the repair", async () => {
    const row = hostControlRow({ configured: false, unprovisioned: true })!;
    expect(row.id).toBe("host-control");
    expect(row.state).toBe("fail");
    expect(row.detail).toContain("openship up");
    // Nothing was dialed, so no packet filter has been established — offering the
    // firewall flag here is the wrong-cause mistake the whole preflight exists to avoid.
    expect(row.detail).not.toContain("--open-host-firewall");
  });

  it("passes when the channel answers, naming where it dialed", async () => {
    expect(hostControlRow({ configured: true, target: "host.docker.internal:22", code: "open" }))
      .toMatchObject({ id: "host-control", state: "pass" });
  });

  it("fails a dropped SYN and points at the firewall — the one case that is the firewall", async () => {
    const row = hostControlRow({ configured: true, target: "host.docker.internal:22", code: "timeout" })!;
    expect(row.state).toBe("fail");
    expect(row.detail).toContain("--open-host-firewall");
  });

  it("sends refused and unresolved to their own causes, not to the firewall", async () => {
    const refused = hostControlRow({ configured: true, target: "host.docker.internal:22", code: "refused" })!;
    expect(refused.state).toBe("fail");
    expect(refused.detail).toContain("sshd");
    expect(refused.detail).not.toContain("firewall");

    const unresolved = hostControlRow({ configured: true, target: "host.docker.internal:22", code: "unresolved" })!;
    expect(unresolved.state).toBe("fail");
    expect(unresolved.detail).toContain("host-gateway");
    expect(unresolved.detail).not.toContain("firewall");
  });

  it("warns — never fails — when the probe couldn't run", async () => {
    // doctor exits 1 on any `fail`, and componentChecks is documented as never hard-
    // failing on a piece it couldn't determine. A stopped stack must not read as a
    // firewall problem.
    const row = hostControlRow({
      configured: true,
      target: "host.docker.internal:22",
      code: "unavailable",
      detail: "no such service: api",
    })!;
    expect(row.state).toBe("warn");
    expect(row.detail).toContain("no such service: api");
  });
});

/**
 * The install shape the LOCAL probe cannot see: a stack brought up by running
 * `docker/docker-compose.yml` by hand. `composeHostChannelExpected` needs
 * `~/.openship/compose/docker-compose.yml` to exist, so on that box `checkHostChannel`
 * reports neither `configured` nor `unprovisioned` and doctor printed nothing at all —
 * from the one command #509's error text names. The API knows its own env on every
 * shape, so `/api/system/health`'s `hostChannel` is the fallback.
 */
describe("the doctor row — API fallback for an install the local probe can't see (#509)", () => {
  const local = { configured: false } as const;

  it("reports a never-provisioned channel with the SAME copy as the local path", () => {
    const row = hostControlRow(local, { ok: false, state: "not_configured" })!;
    expect(row.id).toBe("host-control");
    expect(row.state).toBe("fail");
    // Byte-identical to the local path's row: same state, same remedy, either route.
    expect(row.detail).toBe(hostControlRow({ configured: false, unprovisioned: true })!.detail);
    expect(row.detail).toContain("openship up");
    expect(row.detail).not.toContain("--open-host-firewall");
  });

  it("passes a working channel", () => {
    expect(hostControlRow(local, { ok: true, state: "ok" })).toMatchObject({
      id: "host-control",
      state: "pass",
    });
  });

  it("stays silent for a box that wanted no channel", () => {
    // `disabled` is ok:false but it is a hardening CHOICE, and `not_applicable` is a bare
    // install. Deriving the row from `ok === false` would fail doctor (exit 1) on both.
    expect(hostControlRow(local, { ok: false, state: "disabled" })).toBeNull();
    expect(hostControlRow(local, { ok: true, state: "not_applicable" })).toBeNull();
    expect(hostControlRow(local, null)).toBeNull();
    expect(hostControlRow(local, {})).toBeNull();
  });

  it("fails the address-shaped faults without inventing an address", () => {
    // The endpoint withholds target/host/port and the firewall rule on purpose, so this
    // row must not imply either — it points at the surface that has them.
    for (const state of ["unreachable", "key_unreadable"]) {
      const row = hostControlRow(local, { ok: false, state })!;
      expect(row.state).toBe("fail");
      expect(row.detail).not.toContain("ufw");
      expect(row.detail).not.toContain("host.docker.internal");
    }
  });

  it("never overrides a local probe result", () => {
    // The local probe actually dialed; the API only read its own env. When both speak,
    // the dial wins — otherwise a healthy-looking env would mask a firewalled channel.
    const row = hostControlRow(
      { configured: true, target: "host.docker.internal:22", code: "timeout" },
      { ok: true, state: "ok" },
    )!;
    expect(row.state).toBe("fail");
    expect(row.detail).toContain("--open-host-firewall");
  });
});
