/**
 * Verify the container→host SSH channel from INSIDE the api container, and offer
 * to open the host firewall for it.
 *
 * `provisionHostSshChannel` generates a key, authorizes it, writes
 * `OPENSHIP_HOST_SSH_HOST=host.docker.internal` and reads the host's listener list —
 * none of which involves a packet from the container that will use the channel.
 * The prerequisite it can't satisfy is the host's own firewall: container→
 * `host-gateway` is a host-LOCAL destination, so it traverses `filter/INPUT`,
 * where ufw's default deny lives. Published container ports are DNAT'd and skip
 * ufw entirely, which is exactly why the rest of the stack looks healthy while
 * every host operation dies on a handshake timeout, indistinguishable from a bad
 * key (#490).
 *
 * So: probe it for real, from the container that will use it, and say what's
 * broken. Fixing it means mutating the host's firewall, so it is consent-gated
 * (`--open-host-firewall`, or a prompt that never defaults to yes) in the same
 * shape as the edge takeover.
 *
 * This also covers the case where there is no channel to probe at all: provisioning is
 * best-effort, and the cause it reports at install time is gone the moment the terminal
 * scrolls, so a box whose keygen failed used to reach its first deploy with every host
 * operation already dead (#509). Provisioning now names the cause as it happens
 * (`renderHostChannelIssue`); this is the surface that still says so on a LATER run, and
 * the one `openship doctor` reuses. "No channel" is only a non-event on a box that wanted
 * none — see composeHostChannelExpected.
 *
 * Never fails `up`: this is a degraded install, not a failed one. Degraded in the exact
 * sense HOST_CHANNEL_UNAFFECTED/HOST_CHANNEL_BLOCKED spell out — ORDINARY deploys still
 * run over the Docker socket, while the listed host-touching operations (including a
 * catalog app whose generated config file has to be written on the host) do not.
 */
import { spawnSync } from "node:child_process";

import chalk from "chalk";
import { confirm, isCancel } from "@clack/prompts";
import {
  explainHostChannelCause,
  firewallAllowSteps,
  firewallManager,
  firewallPersists,
  hostChannelRuleScope,
  hostFirewallRule,
  hostFirewallRuleRemoval,
  HOST_CHANNEL_BLOCKED,
  HOST_CHANNEL_NOT_PROVISIONED,
  HOST_CHANNEL_OPT_OUT,
  HOST_CHANNEL_RECHECK,
  HOST_CHANNEL_SYMPTOM,
  HOST_CHANNEL_UNAFFECTED,
  HOST_CHANNEL_UNPROVISIONED,
  wrapText,
  type DistroFamily,
  type FirewallManager,
  type HostChannelCause,
  type SystemFirewall,
} from "@repo/core";

import { composeHostChannel, composeHostChannelExpected, composePaths } from "./compose";
import { thisHost } from "./this-host";

/** What the container saw when it dialed the host. */
export type ProbeCode =
  /** The handshake port answered. */
  | "open"
  /** The SYN vanished — a DROP rule, not a closed port. The firewall case. */
  | "timeout"
  /** Something answered with RST: nothing is listening there. */
  | "refused"
  /** `host.docker.internal` didn't resolve — `extra_hosts` didn't take. */
  | "unresolved"
  /** The address isn't on any network the container can reach. */
  | "no_route"
  /** Dialed and failed some other way. */
  | "error"
  /** We couldn't run the probe at all (container gone, docker exec failed). */
  | "unavailable";

export interface ProbeResult {
  code: ProbeCode;
  /** The raw errno/message, kept verbatim for the operator. */
  detail?: string;
}

export type HostChannelStatus =
  /** Not applicable, or we couldn't tell — nothing printed beyond a hint. */
  | "skipped"
  /** The channel works. */
  | "ok"
  /** It was blocked, we opened the firewall, and the re-probe passed. */
  | "fixed"
  /** Still blocked. Diagnosed and printed; the install continues degraded. */
  | "blocked"
  /**
   * This install wanted a channel and hasn't got one (#509) — provisioning failed,
   * silently, and nothing dialed anything. Distinct from `blocked`: there is no probe
   * result to explain and no firewall rule to offer, because no packet ever left.
   */
  | "unprovisioned";

export interface HostChannelReport {
  status: HostChannelStatus;
  code?: ProbeCode;
  /** The rule an operator can paste, when one applies. */
  rule?: string;
}

export interface HostChannelPreflightDeps {
  platform: NodeJS.Platform;
  interactive: boolean;
  /** The endpoint the install is configured with, or null if there is no channel. */
  channel(): { host: string; port: number; user: string } | null;
  /** Whether a null `channel()` is a fault rather than a non-event (#509). */
  expected(): boolean;
  /** TCP-connect to host:port from inside the api container. Never throws. */
  probe(host: string, port: number): Promise<ProbeResult>;
  /** Subnets the api container dials FROM — the source scope for the rule. */
  sourceCidrs(): string[];
  /**
   * Which firewall is ACTIVE on this box, from the one resolver.
   *
   * The full {@link SystemFirewall} union, not the `ufw|firewalld|null` this file used to
   * detect for itself: `null` conflated "nothing is enforcing" with "we couldn't tell",
   * and an nftables or plain-iptables host — the RHEL-family default — read as the former.
   */
  firewall(): SystemFirewall;
  /** The family whose iptables-persistence package the offered rule should name. */
  distroFamily(): DistroFamily;
  /** How an operator starts sshd HERE — `ssh` on Debian, `sshd` on the RHEL family. */
  sshdEnableHint(): string;
  applyRule(fw: FirewallManager, cidrs: string[], port: number): { ok: boolean; detail?: string };
  confirmOpen(info: { rule: string; port: number }): Promise<boolean>;
  print(text: string): void;
}

const INDENT = "  ";

/** Dimmed, indented, wrapped to a terminal — the shared copy is prose, not lines. */
function dimWrapped(text: string, width = 84): string {
  return wrapText(text, width)
    .map((l) => chalk.dim(`${INDENT}${l}\n`))
    .join("");
}

/**
 * How every "still blocked" exit ends: how to confirm a fix, then the opt-out.
 *
 * Both, every time, in that order. The opt-out used to be the last word on some
 * paths and absent from others, which made "turn the feature off" the most visible
 * thing on the screen for whichever path an operator happened to hit.
 */
function blockedTail(): string {
  return "\n" + dimWrapped(HOST_CHANNEL_RECHECK) + dimWrapped(HOST_CHANNEL_OPT_OUT);
}

/**
 * A TCP connect, printed on stdout as one token so the CALLER never has to read
 * an exit code — `docker exec` failing and the probe reporting a block would
 * otherwise both be "non-zero", which is the conflation this whole file exists to
 * undo. Always exits 0; an empty/garbled stdout is what means "couldn't run it".
 */
const PROBE_SCRIPT = `const net = require("node:net");
const s = net.connect({ host: process.env.OPENSHIP_PROBE_HOST, port: Number(process.env.OPENSHIP_PROBE_PORT) });
const done = (m) => { console.log("openship-probe:" + m); try { s.destroy(); } catch {} process.exit(0); };
s.setTimeout(Number(process.env.OPENSHIP_PROBE_TIMEOUT || 4000));
s.on("connect", () => done("open"));
s.on("timeout", () => done("timeout"));
s.on("error", (e) => done("error:" + (e && e.code ? e.code : String(e && e.message))));`;

/**
 * Probe from inside the api container.
 *
 * It has to run there, not here: the host reaching its own :22 over loopback
 * proves nothing about the bridge, and the loopback rule ufw ships by default is
 * precisely why a host-side check reports green on a box where the channel is dead.
 */
async function realProbe(host: string, port: number): Promise<ProbeResult> {
  const r = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      composePaths.file,
      "exec",
      "-T",
      "-e",
      `OPENSHIP_PROBE_HOST=${host}`,
      "-e",
      `OPENSHIP_PROBE_PORT=${port}`,
      "api",
      "bun",
      "-e",
      PROBE_SCRIPT,
    ],
    { cwd: composePaths.dir, encoding: "utf8", timeout: 30_000 },
  );
  const token = (r.stdout || "").match(/openship-probe:(\S+)/)?.[1];
  if (!token) {
    const why = (r.stderr || r.stdout || r.error?.message || "").trim().split("\n").pop();
    return { code: "unavailable", detail: why || undefined };
  }
  if (token === "open" || token === "timeout") return { code: token };
  const errno = token.startsWith("error:") ? token.slice("error:".length) : token;
  if (errno === "ECONNREFUSED" || errno === "ECONNRESET") return { code: "refused", detail: errno };
  if (errno === "ENOTFOUND" || errno === "EAI_AGAIN") return { code: "unresolved", detail: errno };
  if (errno === "ENETUNREACH" || errno === "EHOSTUNREACH" || errno === "EHOSTDOWN") {
    return { code: "no_route", detail: errno };
  }
  return { code: "error", detail: errno };
}

/**
 * The IPv4 subnets of every docker network the api container is attached to.
 *
 * Read off the network rather than off the container: a container's own address
 * changes on every recreate, so a /32 rule would be correct exactly until the next
 * `openship up`.
 */
function realSourceCidrs(): string[] {
  const id = spawnSync("docker", ["compose", "-f", composePaths.file, "ps", "-q", "api"], {
    cwd: composePaths.dir,
    encoding: "utf8",
  }).stdout?.trim().split("\n")[0];
  if (!id) return [];

  const nets = spawnSync(
    "docker",
    ["inspect", id, "--format", '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}'],
    { encoding: "utf8" },
  ).stdout;
  const cidrs = new Set<string>();
  for (const net of (nets || "").split("\n").map((n) => n.trim()).filter(Boolean)) {
    const subnets = spawnSync(
      "docker",
      ["network", "inspect", net, "--format", '{{range .IPAM.Config}}{{.Subnet}}\n{{end}}'],
      { encoding: "utf8" },
    ).stdout;
    for (const s of (subnets || "").split("\n").map((v) => v.trim())) {
      // IPv4 only: an IPv6 subnet needs `ufw allow ... ` on a v6 rule set, and the
      // bridge gateway the container dials is v4 unless the daemon was configured
      // for v6, which we'd be guessing at.
      if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s)) cidrs.add(s);
    }
  }
  return [...cidrs];
}

/** Prefix for a host mutation: nothing when we're already root, else sudo. In a
 *  TTY sudo may prompt (the operator just consented); headless demands `-n`. */
function sudoPrefix(): string[] {
  if (typeof process.getuid === "function" && process.getuid() === 0) return [];
  return process.stdin.isTTY ? ["sudo"] : ["sudo", "-n"];
}

/**
 * Apply the rule — the SAME steps the block above printed, run through a shell.
 *
 * Through `sh -c` rather than an argv array of our own because that is what makes them
 * the same steps: they come from core's per-manager table, which is also what renders the
 * pasteable block. Spelling them twice (an argv array here, a joined string there) is how
 * the applied rule and the printed one came to differ — this file's `ufw allow` reached
 * the host while the reload firewalld needs was appended in only one of the two places.
 * The shell is also the only thing that can run firewalld's quoted rich-rule as written.
 *
 * Safe to hand to a shell: every step is built from an address `firewallAllowSteps`
 * validated and an integer port it range-checked, so there is no operator text in it.
 */
function realApplyRule(
  fw: FirewallManager,
  cidrs: string[],
  port: number,
): { ok: boolean; detail?: string } {
  const steps = firewallAllowSteps(fw, hostChannelRuleScope(cidrs, port));
  if (!steps.supported) return { ok: false, detail: steps.reason };

  for (const step of steps.value) {
    const [cmd, ...rest] = [...sudoPrefix(), "sh", "-c", step];
    const r = spawnSync(cmd, rest, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
    if (r.status !== 0) {
      return { ok: false, detail: (r.stderr || r.stdout || "").trim().split("\n").pop() };
    }
  }
  return { ok: true };
}

function defaultDeps(): HostChannelPreflightDeps {
  return {
    platform: process.platform,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    channel: composeHostChannel,
    expected: composeHostChannelExpected,
    probe: realProbe,
    sourceCidrs: realSourceCidrs,
    // All three off the one resolver, which measures this box once. This file used to
    // run its own `command -v ufw` + `ufw status` ladder, so the CLI and the API could
    // reach different conclusions about the same host — and it had no way at all to
    // report nftables, the RHEL-family default.
    firewall: () => thisHost().profile.firewall,
    distroFamily: () => thisHost().profile.distroFamily,
    sshdEnableHint: () => thisHost().sshdEnableHint(),
    applyRule: realApplyRule,
    confirmOpen: async ({ rule, port }) => {
      const ok = await confirm({
        message: `Open the host firewall so containers can reach port ${port}?`,
        // Never default-yes: this edits the host's firewall.
        initialValue: false,
      });
      return !isCancel(ok) && ok === true;
    },
    print: (text) => console.log(text),
  };
}

/** What stops working while the channel is blocked — and, as importantly, what
 *  doesn't, so nobody tears down a working install over this. */
function impactLines(): string {
  return (
    dimWrapped(HOST_CHANNEL_UNAFFECTED) +
    chalk.dim(`${INDENT}Blocked until the channel works:\n`) +
    HOST_CHANNEL_BLOCKED.map((l) => chalk.dim(`${INDENT}  · ${l}\n`)).join("") +
    dimWrapped(HOST_CHANNEL_SYMPTOM)
  );
}

/** The probe outcomes that are a diagnosable CAUSE, mapped to the shared vocabulary.
 *  `open` isn't a failure and `unavailable` is a failure of the check, not the channel. */
function causeOf(code: ProbeCode): HostChannelCause | null {
  switch (code) {
    case "timeout":
    case "refused":
    case "unresolved":
    case "no_route":
    case "error":
      return code;
    default:
      return null;
  }
}

/**
 * Explain the specific failure, in the words every other surface uses (#490).
 *
 * `firewall` comes from the shared explanation rather than a local switch: only a
 * dropped packet is the firewall shape, and a refused connection or an unresolved
 * name have their own fixes. Offering a rule for those sends the operator to edit
 * something that was never the problem.
 *
 * `sshdEnableHint` is passed in because core cannot look: it renders the prose for the
 * dashboard too, so it takes the unit name rather than assuming Debian's `ssh`. Here we
 * are on the host in question and can measure it.
 */
function diagnose(
  target: string,
  probe: ProbeResult,
  sshdEnableHint: string,
): { text: string; firewall: boolean } {
  const cause = causeOf(probe.code);
  if (!cause) {
    return {
      firewall: false,
      text: chalk.yellow(`${INDENT}${target} — ${probe.detail || "the connection failed"}\n`),
    };
  }
  const { headline, body, firewallShaped } = explainHostChannelCause(cause, {
    target,
    host: target.split(":")[0],
    detail: probe.detail,
    sshdEnableHint,
  });
  return {
    firewall: firewallShaped,
    text: chalk.yellow(`${INDENT}${headline}\n\n`) + (body ? dimWrapped(body) : ""),
  };
}

export interface HostChannelCheck {
  /** False when there is nothing to check: no channel in `.env`, or not Linux. */
  configured: boolean;
  /**
   * `configured` is false because provisioning FAILED on a box that wanted a channel
   * (#509) — as opposed to a bare install or `--no-host-control`, where no channel is
   * the correct state. Meaningless when `configured` is true.
   */
  unprovisioned?: boolean;
  /** `host:port`, as the container dials it. */
  target?: string;
  code?: ProbeCode;
  detail?: string;
}

/**
 * Probe the channel and report. No printing, no host mutation.
 *
 * The read-only half of {@link verifyHostChannel}, for surfaces that report health
 * rather than repair it (`openship doctor`, which this file tells operators to come
 * back to). It runs the SAME probe from the SAME container, so the two can never
 * disagree about whether the channel works.
 */
export async function checkHostChannel(
  overrides: Partial<HostChannelPreflightDeps> = {},
): Promise<HostChannelCheck> {
  const deps: HostChannelPreflightDeps = { ...defaultDeps(), ...overrides };
  if (deps.platform !== "linux") return { configured: false };
  const channel = deps.channel();
  if (!channel) return { configured: false, unprovisioned: deps.expected() };
  const probe = await deps.probe(channel.host, channel.port);
  return {
    configured: true,
    target: `${channel.host}:${channel.port}`,
    code: probe.code,
    detail: probe.detail,
  };
}

/**
 * Probe the host channel and, on consent, open the firewall for it.
 *
 * `openFirewall` is the `--open-host-firewall` flag: the non-interactive consent,
 * since a headless install has no one to prompt.
 */
export async function verifyHostChannel(
  opts: { openFirewall?: boolean } = {},
  overrides: Partial<HostChannelPreflightDeps> = {},
): Promise<HostChannelReport> {
  const deps: HostChannelPreflightDeps = { ...defaultDeps(), ...overrides };

  // host.docker.internal→host-gateway SSH is the Linux path; nothing to verify
  // where the channel is never provisioned.
  if (deps.platform !== "linux") return { status: "skipped" };

  const channel = deps.channel();
  if (!channel) {
    // No channel, and whether that's a fault depends on whether one was WANTED.
    // `--no-host-control` and a bare install are both correct with none; a compose
    // install whose provisioning failed is #509, and it used to land here as a silent
    // `skipped` — which is how `up` came to report success on a box where every host
    // operation was already dead.
    if (!deps.expected()) return { status: "skipped" };
    deps.print(
      chalk.yellow(`\n${INDENT}Host control was not provisioned on this box.\n\n`) +
        dimWrapped(HOST_CHANNEL_UNPROVISIONED) +
        "\n" +
        impactLines() +
        // The remedy, not a firewall rule: nothing was dialed, so no packet filter has
        // been established — the same line core's `firewallShaped` draws. It carries the
        // recheck command itself, so `blockedTail` would only repeat it.
        chalk.dim(`\n${INDENT}Fix:\n`) +
        dimWrapped(HOST_CHANNEL_NOT_PROVISIONED) +
        dimWrapped(HOST_CHANNEL_OPT_OUT),
    );
    return { status: "unprovisioned" };
  }

  const target = `${channel.host}:${channel.port}`;
  const probe = await deps.probe(channel.host, channel.port);

  if (probe.code === "open") return { status: "ok", code: "open" };

  if (probe.code === "unavailable") {
    // We couldn't ask the container. Don't dress that up as either outcome —
    // claiming "blocked" here would send an operator to edit a firewall over a
    // `docker exec` that failed for its own reasons.
    deps.print(
      chalk.dim(
        `\n${INDENT}Couldn't check the host channel from the api container` +
          `${probe.detail ? ` (${probe.detail})` : ""}.\n` +
          `${INDENT}Verify it later with \`openship doctor\`.\n`,
      ),
    );
    return { status: "skipped", code: "unavailable" };
  }

  const { text, firewall: firewallShaped } = diagnose(target, probe, deps.sshdEnableHint());

  deps.print(
    chalk.yellow(`\n${INDENT}Host control is configured, but the api container can't reach it.\n\n`) +
      text +
      "\n" +
      impactLines(),
  );

  if (!firewallShaped) {
    deps.print(blockedTail());
    return { status: "blocked", code: probe.code };
  }

  const cidrs = deps.sourceCidrs();
  const firewall = deps.firewall();
  // Rendered by @repo/core so this and the rule the API surfaces from inside the
  // container are the same string — an operator who reads one in the install log and the
  // other in the dashboard must not have to wonder which is right. The family only shapes
  // the persistence caveat, and getting it from the resolver is what stopped a RHEL box
  // being told to install `iptables-persistent`.
  const rule = hostFirewallRule(firewall, cidrs, channel.port, deps.distroFamily());

  const ruleBlock =
    chalk.dim(`\n${INDENT}Rule to allow it${cidrs.length ? "" : ` (docker's default pool — the exact subnet couldn't be read)`}:\n`) +
    rule
      .split("\n")
      .map((l) => `${INDENT}  ${chalk.cyan(l)}`)
      .join("\n") +
    "\n";

  /** Name the rule and stop. We can say what to do; doing it is not ours to decide. */
  const offerOnly = (why: string): HostChannelReport => {
    deps.print(ruleBlock + "\n" + dimWrapped(why) + blockedTail());
    return { status: "blocked", code: probe.code, rule };
  };

  // Two separate reasons not to touch it, and they used to be one `if (!fw)`: a manager
  // we can't drive (nothing is enforcing, or we couldn't tell which) versus one we can
  // drive but whose rule evaporates at the next reboot. Both decisions now come from
  // @repo/core, so the CLI and the API's mail firewall step agree about them.
  const manager = firewallManager(firewall);
  if (!manager.supported) return offerOnly(manager.reason);
  if (!firewallPersists(firewall)) {
    return offerOnly(
      `Openship won't add this ${firewall} rule for you: it lives in the running ruleset ` +
        `only, so it would not survive a reboot unless something saves it — and where that ` +
        `is depends on this box. A rule that quietly disappears is worse than one you ` +
        `installed knowing where it lives.`,
    );
  }

  deps.print(ruleBlock);

  const consented = opts.openFirewall
    ? true
    : deps.interactive
      ? await deps.confirmOpen({ rule, port: channel.port })
      : false;

  if (!consented) {
    deps.print(
      chalk.dim(
        `\n${INDENT}Left the firewall alone — apply the rule above when you're ready.\n` +
          (deps.interactive
            ? ""
            : `${INDENT}To have \`openship up\` add it for you: --open-host-firewall\n`),
      ) + blockedTail(),
    );
    return { status: "blocked", code: probe.code, rule };
  }

  const applied = deps.applyRule(manager.value, cidrs, channel.port);
  if (!applied.ok) {
    deps.print(
      chalk.red(
        `\n${INDENT}Couldn't add the rule${applied.detail ? `: ${applied.detail}` : "."}\n`,
      ) +
        chalk.dim(`${INDENT}Run it yourself with the command above.\n`) +
        blockedTail(),
    );
    return { status: "blocked", code: probe.code, rule };
  }

  // Re-probe. Adding the rule is not the same as the channel working — a scoped
  // rule can still miss (a second docker network, a DOCKER-USER chain ahead of it,
  // sshd bound to loopback all along), and reporting success off the exit status of
  // `ufw allow` is how #490 would come back wearing a fix.
  const again = await deps.probe(channel.host, channel.port);
  if (again.code === "open") {
    deps.print(chalk.green(`\n${INDENT}Opened — the host channel is reachable.\n`));
    return { status: "fixed", code: "open", rule };
  }
  // Re-read the failure rather than assume it. A block that CHANGED shape means the
  // packet is getting further than it was, and the DOCKER-USER advice that fits a
  // still-dropped SYN is the wrong answer for a refusal — sending an operator to
  // inspect iptables over an sshd that isn't listening is the same mistake this file
  // exists to stop, just one layer along.
  deps.print(
    chalk.yellow(`\n${INDENT}Rule added, but ${target} still isn't reachable.\n\n`) +
      (again.code === probe.code
        ? chalk.dim(
            `${INDENT}Nothing changed, so something ahead of ${firewall} is dropping it — check\n` +
              `${INDENT}the DOCKER-USER chain and any cloud/provider firewall.\n`,
          )
        : diagnose(target, again, deps.sshdEnableHint()).text) +
      // The rule is a host change made on the premise that it was the blocker, so it
      // must not be left invisible. It is deliberately NOT reverted for us: a failure
      // that changed shape means the rule did something, and it may well be needed
      // once the real cause is fixed.
      chalk.dim(`\n${INDENT}The rule is in place; to undo it:\n`) +
      hostFirewallRuleRemoval(firewall, cidrs, channel.port)
        .split("\n")
        .map((l) => `${INDENT}  ${chalk.cyan(l)}`)
        .join("\n") +
      "\n" +
      blockedTail(),
  );
  return { status: "blocked", code: again.code, rule };
}
