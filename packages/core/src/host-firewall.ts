/**
 * The rule that opens one port, in the syntax each firewall manager actually speaks.
 *
 * One definition, two renderings: `envOps(profile).firewallAllow()` runs these steps on
 * the host, and `hostFirewallRule` (host-channel.ts) prints them with `sudo ` for an
 * operator to paste. Those two were written separately and disagreed — the CLI refused to
 * apply a rule the API applied, because each had its own idea of which managers count.
 *
 * Lives in @repo/core for the reason `host-channel.ts` gives: the dashboard renders the
 * prose form and cannot import the adapters. Pure strings, no measuring.
 */

import { type Answer, answered, refused } from "./answer";
import type { SystemFirewall } from "./host-profile";

/**
 * A firewall Openship can drive.
 *
 * Derived from `SystemFirewall` rather than restated, minus the two members that are
 * answers about *looking* rather than managers: `none` (we looked, nothing is enforcing)
 * and `unknown` (we couldn't look — the API runs in a container and can't see the host's
 * package list). Adding a manager to `SystemFirewall` is a compile error in both tables
 * below, which is the point of deriving it.
 */
export type FirewallManager = Exclude<SystemFirewall, "none" | "unknown">;

export interface FirewallScope {
  /**
   * Source addresses/CIDRs the rule applies to. **Empty means from anywhere** — not
   * "substitute a default". Which default is right depends on what the port is for, so
   * that decision belongs to the caller (see `DOCKER_DEFAULT_POOL_CIDR` for the
   * host-channel one).
   */
  readonly cidrs: readonly string[];
  readonly port: number;
  readonly proto: "tcp" | "udp";
}

/**
 * An address or CIDR safe to interpolate unquoted.
 *
 * Validating beats quoting here for two reasons: these strings also render into
 * operator-facing prose, where `'172.17.0.0/16'` is noise, and a rejected CIDR fails
 * louder than a quoted-but-nonsensical one. Nothing that matches can carry a shell
 * metacharacter, which is what the quoting was for.
 */
const ADDRESS = /^[0-9A-Fa-f.:]+(?:\/\d{1,3})?$/;

function invalidScope(scope: FirewallScope): string | null {
  if (!Number.isInteger(scope.port) || scope.port < 1 || scope.port > 65535) {
    return `${JSON.stringify(scope.port)} is not a port number, so no firewall rule was built for it.`;
  }
  const bad = scope.cidrs.find((cidr) => !ADDRESS.test(cidr));
  if (bad !== undefined) {
    return `${JSON.stringify(bad)} is not an address or CIDR, so no firewall rule was built for it.`;
  }
  return null;
}

function ipFamily(cidr: string): "ipv4" | "ipv6" {
  return cidr.includes(":") ? "ipv6" : "ipv4";
}

function nftSource(cidr: string): string {
  return `${cidr.includes(":") ? "ip6" : "ip"} saddr ${cidr}`;
}

/**
 * Add a rule, per manager. Total over {@link FirewallManager}.
 *
 * The ufw / firewalld / iptables strings are byte-identical to what `hostFirewallRule`
 * printed before this table existed (minus the `sudo ` the prose form adds), so the
 * operator-facing text is unchanged and its pinned assertions still hold.
 */
const ALLOW: Readonly<Record<FirewallManager, (scope: FirewallScope) => readonly string[]>> = {
  ufw: ({ cidrs, port, proto }) =>
    cidrs.length === 0
      ? [`ufw allow ${port}/${proto}`]
      : cidrs.map((c) => `ufw allow from ${c} to any port ${port} proto ${proto}`),

  firewalld: ({ cidrs, port, proto }) => [
    ...(cidrs.length === 0
      ? [`firewall-cmd --permanent --add-port=${port}/${proto}`]
      : cidrs.map(
          (c) =>
            `firewall-cmd --permanent --add-rich-rule='rule family="${ipFamily(c)}" ` +
            `source address="${c}" port port="${port}" protocol="${proto}" accept'`,
        )),
    "firewall-cmd --reload",
  ],

  // Adding a rule to an existing chain only. The detector reports `nftables` exactly when
  // `table inet filter` is present, so the chain is there; if it's named something else
  // (an iptables-nft translation layer, say) this fails loudly rather than half-applying.
  nftables: ({ cidrs, port, proto }) =>
    cidrs.length === 0
      ? [`nft add rule inet filter input ${proto} dport ${port} accept`]
      : cidrs.map(
          (c) => `nft add rule inet filter input ${nftSource(c)} ${proto} dport ${port} accept`,
        ),

  iptables: ({ cidrs, port, proto }) =>
    cidrs.length === 0
      ? [`iptables -I INPUT -p ${proto} --dport ${port} -j ACCEPT`]
      : cidrs.map((c) => `iptables -I INPUT -p ${proto} -s ${c} --dport ${port} -j ACCEPT`),
};

/** Undo a rule, per manager. Total, and nftables states why it can't be one command. */
const REVOKE: Readonly<
  Record<FirewallManager, (scope: FirewallScope) => Answer<readonly string[]>>
> = {
  ufw: ({ cidrs, port, proto }) =>
    answered(
      cidrs.length === 0
        ? [`ufw delete allow ${port}/${proto}`]
        : cidrs.map((c) => `ufw delete allow from ${c} to any port ${port} proto ${proto}`),
    ),

  firewalld: ({ cidrs, port, proto }) =>
    answered([
      ...(cidrs.length === 0
        ? [`firewall-cmd --permanent --remove-port=${port}/${proto}`]
        : cidrs.map(
            (c) =>
              `firewall-cmd --permanent --remove-rich-rule='rule family="${ipFamily(c)}" ` +
              `source address="${c}" port port="${port}" protocol="${proto}" accept'`,
          )),
      "firewall-cmd --reload",
    ]),

  nftables: () =>
    refused(
      "An nftables rule is deleted by handle, and the handle only exists in the live " +
        "ruleset — there is no command that removes a rule by its contents. Read it with " +
        "`nft -a list chain inet filter input`, then " +
        "`nft delete rule inet filter input handle <n>`.",
    ),

  iptables: ({ cidrs, port, proto }) =>
    answered(
      cidrs.length === 0
        ? [`iptables -D INPUT -p ${proto} --dport ${port} -j ACCEPT`]
        : cidrs.map((c) => `iptables -D INPUT -p ${proto} -s ${c} --dport ${port} -j ACCEPT`),
    ),
};

/**
 * The manager we could drive here, or why we can't.
 *
 * `none` and `unknown` are answers about *looking* rather than managers, and they refuse
 * for different reasons: nothing is enforcing (so there is no rule to add) versus we
 * couldn't tell (so guessing would look like it worked). Two callers need this decision —
 * `envOps` for a remote host and the CLI's preflight for the box it runs on — and when
 * each made it locally they disagreed about which managers counted.
 */
export function firewallManager(firewall: SystemFirewall): Answer<FirewallManager> {
  switch (firewall) {
    case "ufw":
    case "firewalld":
    case "nftables":
    case "iptables":
      return answered(firewall);
    case "none":
      return refused(
        "No firewall is active on this host, so there is no rule to add — traffic reaches " +
          "it already. Check a cloud security group / network ACL if it doesn't.",
      );
    case "unknown":
      return refused(
        "Openship could not determine which firewall this host runs, so it will not " +
          "guess at a rule — applying an iptables rule where firewalld is managing the " +
          "chains looks like it worked and is gone after a reload.",
      );
  }
}

/**
 * Whether a rule added through this manager is still there after a reboot.
 *
 * A total record rather than an `=== "ufw" || === "firewalld"` test, so a manager added to
 * {@link SystemFirewall} has to state its answer instead of inheriting `false`.
 */
const PERSISTS: Readonly<Record<SystemFirewall, boolean>> = {
  // Both keep their own on-disk config and reload it at boot.
  ufw: true,
  firewalld: true,
  // The rule lives in the running ruleset only; something else has to save it.
  nftables: false,
  iptables: false,
  // Nothing was added, so there is nothing to survive anything.
  none: false,
  unknown: false,
};

/**
 * True when Openship may apply a rule and expect it to still be there tomorrow.
 *
 * The CLI refused to apply an unpersisted rule while the API applied one, so the same box
 * got a different answer depending on which surface asked. This is that one answer.
 */
export function firewallPersists(firewall: SystemFirewall): boolean {
  return PERSISTS[firewall];
}

/** The steps that open `scope`, in `manager`'s syntax. No `sudo` — elevation is the caller's. */
export function firewallAllowSteps(
  manager: FirewallManager,
  scope: FirewallScope,
): Answer<readonly string[]> {
  const invalid = invalidScope(scope);
  return invalid ? refused(invalid) : answered(ALLOW[manager](scope));
}

/** The steps that close `scope` again. */
export function firewallRevokeSteps(
  manager: FirewallManager,
  scope: FirewallScope,
): Answer<readonly string[]> {
  const invalid = invalidScope(scope);
  return invalid ? refused(invalid) : REVOKE[manager](scope);
}
