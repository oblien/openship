/**
 * The container→host SSH channel (#490), explained once.
 *
 * Five surfaces talk about this channel: the CLI preflight at install, the API's
 * boot banner, `openship doctor`, the dashboard's server banner, and whatever
 * deploy log a host operation dies in. They had already drifted, and drift here is
 * expensive in a specific way: every line below is either "your install is fine,
 * this one feature isn't" or "your install is broken", and an operator who reads
 * the wrong one either tears down a working box or ignores a dead feature for
 * months.
 *
 * This lives in @repo/core rather than @repo/adapters because the dashboard is one
 * of the five and cannot import the adapters (ssh/docker code, server-only). Keep
 * it isomorphic: no `node:*`, no measuring — the facts and the shapes only. What
 * is actually true of one host (which firewall it runs, which CIDRs its bridges
 * use, whether the packet was dropped or refused) is measured by the caller and
 * passed in.
 */

import type { Answer } from "./answer";
import {
  firewallAllowSteps,
  firewallRevokeSteps,
  type FirewallManager,
  type FirewallScope,
} from "./host-firewall";
import type { DistroFamily, SystemFirewall } from "./host-profile";

/** The reassurance, and it is load-bearing: this is a degraded install, not a broken one. */
export const HOST_CHANNEL_UNAFFECTED =
  "Ordinary deploys to this box still work — they go through the Docker socket.";

/** Everything that genuinely stops working. Verified against the call sites, not guessed. */
export const HOST_CHANNEL_BLOCKED: readonly string[] = [
  "the host terminal, host system info and host port scans",
  "taking over :80/:443 from a proxy Openship didn't start",
  "installing or updating the mail engine",
  "deploying a catalog app that needs a generated config file on the host (Supabase's kong.yml, say)",
];

/**
 * Kept out of the blocked list on purpose: it is a symptom of the same break, not
 * a capability, and reading it in a list of lost features invites the conclusion
 * that the box itself went down.
 */
export const HOST_CHANNEL_SYMPTOM =
  'This box also reads "Offline" in the dashboard\'s server list while the channel is down.';

/**
 * The two commands this module ever tells an operator to run: the one that builds the
 * channel, and the one that reports on it. Named constants because they are quoted in
 * prose on five surfaces, and a command an operator can't paste verbatim is worth
 * nothing.
 */
export const HOST_CHANNEL_PROVISION_COMMAND = "openship up";
export const HOST_CHANNEL_RECHECK_COMMAND = "openship doctor";

export const HOST_CHANNEL_RECHECK = `Re-check it any time with \`${HOST_CHANNEL_RECHECK_COMMAND}\`.`;

/**
 * The remedy for a channel that was never provisioned — repair AND verification, in
 * one sentence.
 *
 * This is #509's copy, and it was written three times independently: the adapters'
 * health hint, the `createHostExecutor` throw an operator reads in a failed deploy
 * log, and the dashboard banner. All three said something slightly different, none
 * named a way to CHECK the result, and the one people quoted in the issue was the
 * deploy-log throw. The verification half is load-bearing rather than polite: the
 * repair runs on the host and the fault is observed in a container, so "did it work"
 * is a genuinely separate question from "did the command succeed".
 */
export const HOST_CHANNEL_NOT_PROVISIONED =
  // Two sentences rather than one clause chain, for the reason HOST_CHANNEL_OPT_OUT
  // gives: every surface wraps this to a terminal width, and both commands have to
  // survive the break. Starting the second sentence with its command keeps it whole.
  `Re-run \`${HOST_CHANNEL_PROVISION_COMMAND}\` to provision the host channel. ` +
  `\`${HOST_CHANNEL_RECHECK_COMMAND}\` reports whether it worked.`;

/**
 * Why there is no channel, for the state where one was expected and never arrived.
 *
 * Kept separate from the remedy above so a surface can name the observation without
 * the instruction (a status row) or both (a banner, a boot log).
 */
export const HOST_CHANNEL_UNPROVISIONED =
  "Openship is running in a container with no host channel — OPENSHIP_HOST_SSH_HOST is " +
  "unset, so there is no address to reach the host at and nothing has been dialed.";

/**
 * The account the container→host channel logs in as, when nothing has been provisioned.
 *
 * `root` because that is what `chooseHostChannelUser` authorizes whenever it can reach it
 * — the platform's host operations are root-owned by contract (see `stateDir()` in
 * adapters/system/environment-ops). It is a DEFAULT, not a requirement: the value is
 * whatever provisioning wrote, and this is only the answer for an install that has not
 * written one.
 */
export const HOST_CHANNEL_DEFAULT_ACCOUNT = "root";

/**
 * THE host-channel account resolver.
 *
 * One function because this expression was spelled independently in five places — the
 * adapters' dial (`hostChannelUser`), the api's self-server row (`desiredSshUser`), and
 * three spots in the CLI's compose layer — and #527 is what that costs. The row rendered
 * `admin@<ip>` from one copy while the dial used `root@host.docker.internal` from another,
 * so the operator was shown an account the channel was not using, went to correct it, and
 * corrected nothing.
 *
 * The row and the dial cannot disagree if they cannot spell it separately. Takes the
 * environment as an argument rather than reading `process.env` because its callers read
 * from two different sources: a live process (adapters, api) and a parsed `.env` file on
 * disk (the CLI, deciding what to write).
 */
export function hostChannelAccount(env: {
  OPENSHIP_HOST_SSH_USER?: string | undefined;
}): string {
  return env.OPENSHIP_HOST_SSH_USER?.trim() || HOST_CHANNEL_DEFAULT_ACCOUNT;
}

/**
 * Why a channel that ANSWERS is still not working: sshd took the connection and then
 * refused the key.
 *
 * Its own state and its own copy because of #527. The port was open, so the health
 * check called the channel healthy, and the first thing the operator saw was a generic
 * "SSH credentials rejected" card on the This Server row — a row whose stored
 * credentials this channel never uses. They spent a dozen messages moving key files
 * between /tmp, /root and ~/.ssh, none of which anything reads.
 *
 * Both causes are named because the remedies differ and neither is observable from
 * inside the container: we can read neither the host's sshd_config nor the target
 * account's authorized_keys. Naming only the first sends every hardened host to audit
 * a file that was already correct — the same mistake #490 made with firewalls.
 */
export const HOST_CHANNEL_AUTH_REJECTED =
  "The host accepted the connection and then refused Openship's key. Either the key is " +
  "no longer in the target account's `authorized_keys`, or sshd does not permit that " +
  "account to log in at all (for a root channel, check `sshd -T | grep -i permitrootlogin`).";

/**
 * The same fault in one line, for a surface with a column rather than a paragraph — a
 * `openship doctor` row. Shared rather than re-worded there, because a doctor row that
 * disagrees with the banner about the same probe is worse than no row.
 */
export const HOST_CHANNEL_AUTH_REJECTED_SHORT =
  "the host refused the channel key — re-authorize it, or permit that account to log in";

/**
 * The sentence that stops the credential hunt.
 *
 * Every surface that can show an auth failure ON the local row needs it, because the
 * row displays `user@host` and offers an edit form, and both are lies for this
 * connection. Said once, here, so the banner, the deploy-log throw and the doctor row
 * cannot word it differently.
 */
export const HOST_CHANNEL_ROW_CREDENTIALS_UNUSED =
  "The SSH credentials stored on this server are not used for this connection — the " +
  `host channel has its own key, provisioned by \`${HOST_CHANNEL_PROVISION_COMMAND}\`.`;

/**
 * The opt-out, stated as what it is.
 *
 * It used to sit one line under the fix as a co-equal "Or…", which made the warning
 * itself the problem to be solved: the fastest way to silence it is to switch the
 * feature off, and nothing said that the list above stays dark afterwards. Turning
 * host control off is a hardening decision, not a repair.
 */
export const HOST_CHANNEL_OPT_OUT =
  // The command sits early in the sentence on purpose: every surface wraps this to a
  // terminal width, and a line break through the middle of a command is a command an
  // operator can't copy.
  "Not a fix, a choice: `openship up --no-host-control` turns the channel off and takes " +
  "its key back, for a box where the api container should never run host commands — the " +
  "items above stay unavailable.";

/**
 * Why a dial to the host failed, in the terms a TCP probe can actually establish.
 *
 * Named to match `TcpProbeFailure` in the adapters so the mapping between them is
 * the identity function and can't rot.
 */
export type HostChannelCause = "timeout" | "refused" | "unresolved" | "no_route" | "error";

export interface HostChannelCauseContext {
  /** `user@host:port`, as the operator configured it. */
  target: string;
  /** The hostname alone, for the DNS case. */
  host?: string;
  /** An errno or message from the probe, e.g. `ETIMEDOUT`. */
  detail?: string;
  /**
   * How an operator enables sshd on THIS host, ready to paste — pass
   * `envOps(profile).sshdEnableHint()`.
   *
   * A parameter rather than a literal because the unit is `ssh` on Debian/Ubuntu,
   * `sshd` across the RHEL family, an `rc-service` pair on Alpine and
   * `systemsetup -setremotelogin` on macOS. This module rendered the Debian form
   * unconditionally, which is a command that silently does nothing on exactly the
   * hosts most likely to be reading it. Absent = the caller genuinely couldn't look
   * (the API runs in a container), and {@link SSHD_ENABLE_HINT_UNKNOWN} names both.
   */
  sshdEnableHint?: string;
}

/**
 * The enable-sshd line for a host whose init and distro we don't know.
 *
 * Still the systemd/Debian command, because it is right on the majority of boxes and a
 * refusal to name any command is useless in a "your channel is down" message — but the
 * comment stops it being a wrong claim, and a caller with a profile passes the exact one.
 */
export const SSHD_ENABLE_HINT_UNKNOWN =
  "sudo systemctl enable --now ssh   # RHEL-family hosts name the unit 'sshd'";

export interface HostChannelExplanation {
  /** What was observed, one line, no advice. Safe to print in a colour. */
  headline: string;
  /** Why it happens and what to do about it that is not a firewall rule. May be empty. */
  body: string;
  /**
   * Whether a firewall rule is the plausible repair. Only a dropped packet is
   * firewall-shaped; offering a rule for a refusal or a DNS failure sends an
   * operator to widen their firewall for no reason.
   */
  firewallShaped: boolean;
}

/** The full prose for one cause. Everything a human needs except the host-specific rule. */
export function explainHostChannelCause(
  cause: HostChannelCause,
  ctx: HostChannelCauseContext,
): HostChannelExplanation {
  const at = ctx.target;
  const suffix = ctx.detail ? ` (${ctx.detail})` : "";
  switch (cause) {
    case "timeout":
      return {
        headline: `${at} — no response, not even a refusal${suffix}`,
        body:
          "That is what a dropped packet looks like. This address is host-local, so the " +
          "connection traverses the host's filter/INPUT chain, where a default-deny " +
          "firewall applies. Published container ports are forwarded and never reach that " +
          "chain, which is why the rest of the stack looks healthy.",
        firewallShaped: true,
      };
    case "refused":
      return {
        headline: `${at} — connection refused${suffix}`,
        // The command sits on its own line (wrapText honours the break) so no terminal
        // width can fold it in half and hand the operator something unpasteable.
        body:
          "The packet arrived and nothing accepted it: either sshd isn't listening on an " +
          "address the containers can reach, or something is rejecting rather than dropping " +
          "it. A firewall rule alone won't fix a refusal. Check that ListenAddress in " +
          "/etc/ssh/sshd_config isn't pinned to 127.0.0.1, then:" +
          `\n  ${ctx.sshdEnableHint ?? SSHD_ENABLE_HINT_UNKNOWN}`,
        firewallShaped: false,
      };
    case "unresolved":
      return {
        headline: `"${ctx.host ?? at}" didn't resolve inside the Openship container${suffix}`,
        body:
          "The host alias needs `extra_hosts: host.docker.internal:host-gateway` and Docker " +
          "20.10+; under rootless Docker the host gateway isn't provided at all. Re-run " +
          "`openship up` to reprovision the channel.",
        firewallShaped: false,
      };
    case "no_route":
      return {
        headline: `${at} — no route from the Openship container${suffix}`,
        body:
          "The address the channel was provisioned with isn't reachable on this box's " +
          "networks. Re-run `openship up` to reprovision it, or point " +
          "OPENSHIP_HOST_SSH_HOST at an address the container can reach.",
        firewallShaped: false,
      };
    case "error":
      return {
        headline: `${at} — ${ctx.detail ?? "the connection failed"}`,
        body: "",
        firewallShaped: false,
      };
  }
}

/** The same fact in one clause, for a status table row. No advice — the caller owns that. */
export function summarizeHostChannelCause(
  cause: HostChannelCause,
  ctx: HostChannelCauseContext,
): string {
  const at = ctx.target;
  switch (cause) {
    case "timeout":
      return `${at} dropped the connection`;
    case "refused":
      return `${at} refused — sshd isn't listening where containers can reach it`;
    case "unresolved":
      return `${ctx.host ?? at} didn't resolve in the container — needs Docker 20.10+ host-gateway`;
    case "no_route":
      return `no route to ${at} from the container`;
    case "error":
      return `${at} — ${ctx.detail ?? "the connection failed"}`;
  }
}

/**
 * Docker's default address pool. A fallback for when the real bridge CIDRs can't be
 * read: it is a /12 covering every default-pool bridge, so a rule written against it
 * works, at the cost of being wider than one written against the actual bridge.
 */
export const DOCKER_DEFAULT_POOL_CIDR = "172.16.0.0/12";

/**
 * How a raw iptables rule is made to survive a reboot, per family.
 *
 * `iptables-persistent` is a Debian package name, and it was printed to every host —
 * including the RHEL boxes where the package is `iptables-services` and the save step is
 * a separate command. `suse`/`arch`/`unknown` get the generic sentence on purpose: those
 * are hosts Openship either refuses or hasn't identified, and naming a package that may
 * not exist there is worse than naming none.
 */
const PERSIST_IPTABLES: Readonly<Record<DistroFamily, string>> = {
  debian: "persist it with `sudo apt-get install iptables-persistent`, which saves the current rules as it installs",
  rhel: "persist it with `sudo dnf install iptables-services && sudo service iptables save`",
  alpine: "persist it with `sudo rc-update add iptables && sudo /etc/init.d/iptables save`",
  suse: "persist it with whatever this distro restores iptables from at boot",
  arch: "persist it with whatever this distro restores iptables from at boot",
  unknown:
    "persist it with iptables-persistent (Debian/Ubuntu) or iptables-services (RHEL family)",
};

/** A comment line, so a caveat pasted along with the rule is inert rather than a command. */
function note(text: string): string {
  return `# (${text})`;
}

/**
 * One manager's steps as an operator would paste them.
 *
 * `sudo ` is added here and nowhere else: `host-firewall.ts` renders the same steps for
 * `envOps().firewallAllow()`, which runs them already-elevated on the host. That split is
 * the whole reason those tables live there rather than being spelled twice.
 *
 * A refusal renders as a comment rather than an empty string — an operator who is shown
 * nothing concludes there is nothing to do.
 */
function pasteable(steps: Answer<readonly string[]>): string {
  return steps.supported
    ? steps.value.map((step) => `sudo ${step}`).join("\n")
    : steps.reason
        .split("\n")
        .map((line) => `# ${line}`)
        .join("\n");
}

/**
 * The scope of a host-channel firewall rule.
 *
 * Exported because the CLI both *shows* a rule (via `hostFirewallRule`) and *applies* one
 * (via `firewallAllowSteps`), and those two had grown separate scope builders — so the
 * fallback CIDR could drift between what an operator was told and what actually ran.
 */
export function hostChannelRuleScope(cidrs: readonly string[], port: number): FirewallScope {
  // Empty means "from anywhere" to host-firewall.ts, which is not what a channel rule
  // wants: this port is for the Docker bridges, so an unreadable bridge list falls back
  // to the pool that covers all of them rather than to 0.0.0.0/0.
  return { cidrs: cidrs.length > 0 ? cidrs : [DOCKER_DEFAULT_POOL_CIDR], port, proto: "tcp" };
}

/** The forms offered when we couldn't look, each commented so the wrong one is inert. */
function everyForm(
  render: (manager: FirewallManager) => string,
  managers: readonly FirewallManager[],
): string {
  return managers.flatMap((manager) => [`# ${manager}:`, render(manager)]).join("\n");
}

/** `iptables` last: it is the fallback, and the one whose rule needs a caveat. */
const OFFER_ORDER: readonly FirewallManager[] = ["ufw", "firewalld", "nftables", "iptables"];

/**
 * The rule that opens the channel, in the syntax this host actually speaks.
 *
 * `family` only shapes the persistence caveat on a raw iptables/nftables rule; every
 * managed form is family-independent. It defaults to `unknown` so a caller without a
 * profile gets the both-package-names sentence instead of Debian's answer.
 */
export function hostFirewallRule(
  firewall: SystemFirewall,
  cidrs: readonly string[],
  port: number,
  family: DistroFamily = "unknown",
): string {
  const scope = hostChannelRuleScope(cidrs, port);
  const allow = (manager: FirewallManager) => pasteable(firewallAllowSteps(manager, scope));
  const unpersisted = (manager: FirewallManager, caveat: string) =>
    `${allow(manager)}\n${note(caveat)}`;

  /**
   * One renderer for one manager, so the `unknown` offer prints the SAME text the
   * measured branches do — caveats included. Rendering the offer with a bare `allow`
   * dropped the reboot warning from exactly the two forms that need it, for exactly the
   * operator who has the least information: the one whose host we could not read.
   */
  const ruleFor = (manager: FirewallManager): string => {
    switch (manager) {
      case "ufw":
      case "firewalld":
        return allow(manager);
      case "nftables":
        return unpersisted(
          "nftables",
          "an `nft add rule` is gone at the next reboot — write it into /etc/nftables.conf " +
            "(or your distro's ruleset file) to keep it",
        );
      case "iptables":
        return unpersisted(
          "iptables",
          `a raw iptables rule does not survive a reboot — ${PERSIST_IPTABLES[family]}`,
        );
    }
  };

  switch (firewall) {
    case "ufw":
    case "firewalld":
    case "nftables":
    case "iptables":
      return ruleFor(firewall);
    // Two different observations, one rule: `iptables` means raw rules are already the
    // only thing enforcing here, `none` means nothing is. Either way iptables is what
    // this host speaks, and either way the rule is lost at reboot.
    case "none":
      return ruleFor("iptables");
    case "unknown":
      return everyForm(ruleFor, OFFER_ORDER);
  }
}

/**
 * The undo, printed next to any rule we apply on the operator's behalf.
 *
 * Takes the full union rather than the two managers we can apply through. The narrow
 * signature made `none`/`unknown` compile-time impossible here while `hostFirewallRule`
 * accepted them, so a caller holding one profile-derived value could not pass it to both.
 */
export function hostFirewallRuleRemoval(
  firewall: SystemFirewall,
  cidrs: readonly string[],
  port: number,
): string {
  const scope = hostChannelRuleScope(cidrs, port);
  const revoke = (manager: FirewallManager) => pasteable(firewallRevokeSteps(manager, scope));

  switch (firewall) {
    case "ufw":
    case "firewalld":
    case "nftables":
      return revoke(firewall);
    case "iptables":
    case "none":
      return revoke("iptables");
    case "unknown":
      return everyForm(revoke, OFFER_ORDER);
  }
}
