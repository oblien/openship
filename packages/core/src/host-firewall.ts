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
import { infrastructureIpv4 } from "./infrastructure";
import { shellQuote } from "./shell-split";

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

/** Read-only prerequisite checks shared by tool installation and network setup. */
export const IPTABLES_PROBES = {
  version: "iptables --version",
  conntrack: "iptables -m conntrack --help",
} as const;

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

export interface ManagedFirewallRules {
  up: string[];
  down: string[];
  inspect: string;
  /** Canonical owned rules, used to detect drift before commit and during recovery. */
  snapshot?: string;
}

export interface ManagedFirewallAccess {
  privateIp: string;
  incoming: string[];
  outgoing: string[];
}

// Resolve nft rule handles on the host immediately before the atomic batch. Only
// tagged jumps and our own chains are removed; no host table is flushed/restored.
const MANAGED_NFT = String.raw`
import json, subprocess, sys
c = json.loads(sys.argv[1]); action = sys.argv[2]
prefix = 'OSWG_' + c['identity'][:16] + '_'
tag = 'openship-network-' + c['identity']
def call(args, data=None):
    result = subprocess.run(['nft'] + args, input=data, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    if result.returncode: raise RuntimeError('Could not inspect or update the owned nftables rules.')
    return result.stdout
rows = json.loads(call(['-j', 'list', 'ruleset']))['nftables']
chains = [row['chain'] for row in rows if 'chain' in row]
rules = [row['rule'] for row in rows if 'rule' in row]
owned = lambda rule: rule.get('comment') in (tag + '-I', tag + '-O') or rule.get('chain', '').startswith(prefix)
if action != 'down':
    for hook in ('input', 'output'):
        if not any(chain.get('family') == 'inet' and chain.get('table') == 'filter' and chain.get('name') == hook and chain.get('hook') == hook for chain in chains):
            raise RuntimeError('Managed nftables requires inet filter input/output base chains.')
    for chain in chains:
        if chain.get('family') not in ('ip', 'inet') or chain.get('hook') not in ('input', 'output'): continue
        if chain.get('family') == 'inet' and chain.get('table') == 'filter' and chain.get('name') in ('input', 'output'): continue
        has_rules = any(rule.get('family') == chain.get('family') and rule.get('table') == chain.get('table') and rule.get('chain') == chain.get('name') for rule in rules)
        if chain.get('policy', 'accept') != 'accept' or has_rules:
            raise RuntimeError('Additional nftables input/output base chains need a custom firewall adapter.')
    for rule in rules:
        if not owned(rule) and prefix in json.dumps(rule):
            raise RuntimeError('A foreign nftables rule refers to an OpenShip-owned chain.')
def clean(value):
    if isinstance(value, list): return [clean(item) for item in value]
    if isinstance(value, dict): return {key: clean(item) for key, item in value.items() if key not in ('handle', 'index', 'position', 'packets', 'bytes')}
    return value
if action == 'snapshot':
    for suffix in ('I', 'O', 'F'):
        if not any(chain.get('family') == 'inet' and chain.get('table') == 'filter' and chain.get('name') == prefix + suffix for chain in chains):
            raise RuntimeError('An owned access-policy chain is missing.')
    for parent, suffix in (('input', 'I'), ('output', 'O')):
        found = False
        for rule in rules:
            if rule.get('family') != 'inet' or rule.get('table') != 'filter' or rule.get('chain') != parent: continue
            if rule.get('comment') == tag + '-' + suffix: found = True; break
            if not str(rule.get('comment', '')).startswith('openship-network-'):
                raise RuntimeError('A host firewall rule precedes the network access policy. Review the firewall before continuing.')
        if not found: raise RuntimeError('The access-policy jump is missing.')
    print(json.dumps(clean([row for row in rows if ('chain' in row and row['chain'].get('name', '').startswith(prefix)) or ('rule' in row and owned(row['rule']))]), sort_keys=True))
    sys.exit(0)
if action == 'inspect':
    foreign = [row for row in rows if 'metainfo' not in row and not ('chain' in row and row['chain'].get('name', '').startswith(prefix)) and not ('rule' in row and owned(row['rule']))]
    print(json.dumps(clean(foreign), sort_keys=True))
    if any(chain.get('name', '').startswith(prefix) for chain in chains): print(prefix + 'owned')
    sys.exit(0)
batch = []
for rule in rules:
    if rule.get('comment') in (tag + '-I', tag + '-O'):
        if rule.get('family') != 'inet' or rule.get('table') != 'filter' or rule.get('chain') not in ('input', 'output'):
            raise RuntimeError('A managed nftables rule moved outside its owned scope.')
        batch.append('delete rule inet filter ' + rule['chain'] + ' handle ' + str(int(rule['handle'])))
for suffix in ('I', 'O', 'F'):
    chain = prefix + suffix
    if any(item.get('family') == 'inet' and item.get('table') == 'filter' and item.get('name') == chain for item in chains):
        batch += ['flush chain inet filter ' + chain, 'delete chain inet filter ' + chain]
if action == 'up':
    for suffix, parent in (('I', 'input'), ('O', 'output')):
        chain = prefix + suffix
        batch += ['add chain inet filter ' + chain, 'insert rule inet filter ' + parent + ' jump ' + chain + ' comment "' + tag + '-' + suffix + '"']
    for peer in c['peers']:
        batch.append('add rule inet filter ' + prefix + 'I ip saddr ' + peer['endpoint'] + '/32 udp dport ' + str(c['listenPort']) + ' accept')
        batch.append('add rule inet filter ' + prefix + 'O ip daddr ' + peer['endpoint'] + '/32 udp dport ' + str(peer['listenPort']) + ' accept')
        if not c.get('access'):
            batch.append('add rule inet filter ' + prefix + 'I iifname "' + c['interfaceName'] + '" ip saddr ' + peer['privateIp'] + '/32 accept')
            batch.append('add rule inet filter ' + prefix + 'O oifname "' + c['interfaceName'] + '" ip daddr ' + peer['privateIp'] + '/32 accept')
    if c.get('access'):
        access = c['access']; iface = '"' + c['interfaceName'] + '"'; local = access['privateIp'] + '/32'
        batch.append('add chain inet filter ' + prefix + 'F { type filter hook forward priority -10; policy accept; }')
        def add(suffix, expression): batch.append('add rule inet filter ' + prefix + suffix + ' ' + expression)
        add('F', 'iifname ' + iface + ' oifname ' + iface + ' drop')
        for direction, peers in (('incoming', access['incoming']), ('outgoing', access['outgoing'])):
            for peer in peers:
                remote = peer + '/32'
                if direction == 'incoming':
                    add('I', 'iifname ' + iface + ' ip saddr ' + remote + ' ip daddr ' + local + ' ct direction original ct state { new, established } accept')
                    add('O', 'oifname ' + iface + ' ip saddr ' + local + ' ip daddr ' + remote + ' ct direction reply ct state { established, related } accept')
                    add('F', 'iifname ' + iface + ' ip saddr ' + remote + ' ct original ip daddr ' + local + ' ct direction original ct state { new, established } return')
                    add('F', 'oifname ' + iface + ' ip daddr ' + remote + ' ct original ip daddr ' + local + ' ct direction reply ct state { established, related } return')
                else:
                    add('O', 'oifname ' + iface + ' ip saddr ' + local + ' ip daddr ' + remote + ' ct direction original ct state { new, established } accept')
                    add('I', 'iifname ' + iface + ' ip saddr ' + remote + ' ip daddr ' + local + ' ct direction reply ct state { established, related } accept')
                    add('F', 'oifname ' + iface + ' ip daddr ' + remote + ' ct direction original ct state { new, established } return')
                    add('F', 'iifname ' + iface + ' ip saddr ' + remote + ' ct direction reply ct state { established, related } return')
        add('I', 'iifname ' + iface + ' drop'); add('O', 'oifname ' + iface + ' drop')
        add('F', 'iifname ' + iface + ' drop'); add('F', 'oifname ' + iface + ' drop')
if batch: call(['-f', '-'], '\n'.join(batch) + '\n')
`;

const MANAGED_IPTABLES_SNAPSHOT = String.raw`
import json, subprocess, sys
c = json.loads(sys.argv[1]); prefix = 'OSWG_' + c['identity'][:16] + '_'
def rules(chain):
    result = subprocess.run(['iptables', '-w', '5', '-S', chain], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    if result.returncode: raise RuntimeError('An owned access-policy chain is missing: ' + chain)
    return result.stdout.splitlines()
snapshot = {}
for suffix, parent in (('I', 'INPUT'), ('O', 'OUTPUT'), ('F', 'FORWARD')):
    jump = '-A ' + parent + ' -m comment --comment openship-network-' + c['identity'] + ' -j ' + prefix + suffix
    found = False
    for line in rules(parent):
        if not line.startswith('-A '): continue
        if line.replace('"', '') == jump: found = True; break
        if '-m comment --comment openship-network-' not in line.replace('"', '') or ' -j OSWG_' not in line:
            raise RuntimeError('A host firewall rule precedes the network access policy. Review the firewall before continuing.')
    if not found: raise RuntimeError('The access-policy jump is missing: ' + parent)
    snapshot[suffix] = rules(prefix + suffix)
print(json.dumps(snapshot, sort_keys=True))
`;

/** Only dedicated chains are changed. Never flush or restore the host ruleset. */
export function managedNetworkFirewall(
  manager: SystemFirewall,
  identity: string,
  interfaceName: string,
  listenPort: number,
  peers: readonly { endpoint: string; listenPort: number; privateIp: string }[],
  access?: ManagedFirewallAccess,
): Answer<ManagedFirewallRules> {
  if (
    !/^[a-f0-9]{32}$/.test(identity) ||
    !/^oswg[a-f0-9]{10}$/.test(interfaceName) ||
    !Number.isInteger(listenPort) ||
    listenPort < 1024 ||
    listenPort > 65535 ||
    (access &&
      (infrastructureIpv4(access.privateIp) === null ||
        [...access.incoming, ...access.outgoing].some(
          (ip) => !peers.some((peer) => peer.privateIp === ip),
        ))) ||
    peers.some(
      (peer) =>
        infrastructureIpv4(peer.endpoint) === null ||
        infrastructureIpv4(peer.privateIp) === null ||
        !Number.isInteger(peer.listenPort) ||
        peer.listenPort < 1024 ||
        peer.listenPort > 65535,
    )
  )
    return refused("Invalid managed firewall scope.");
  if (manager === "none" && !access) return answered({ up: [], down: [], inspect: "true" });
  // Preparation installs iptables through the shared toolchain for an unfiltered host.
  if (manager === "none") manager = "iptables";
  if (manager === "nftables") {
    const input = shellQuote(
      JSON.stringify({ identity, interfaceName, listenPort, peers, access }),
    );
    const command = `python3 -c ${shellQuote(MANAGED_NFT)} ${input}`;
    return answered({
      up: [`${command} up`],
      down: [`${command} down`],
      inspect: `${command} inspect`,
      ...(access ? { snapshot: `${command} snapshot` } : {}),
    });
  }
  if (manager !== "iptables")
    return refused(
      `Managed networking currently supports unfiltered hosts, iptables, and nftables with inet filter input/output chains. This host uses ${manager}; its firewall needs an owned-rule adapter before OpenShip can safely manage it.`,
    );
  const input = `OSWG_${identity.slice(0, 16)}_I`;
  const output = `OSWG_${identity.slice(0, 16)}_O`;
  const forward = `OSWG_${identity.slice(0, 16)}_F`;
  const comment = `openship-network-${identity}`;
  const up: string[] = [];
  const down: string[] = [];
  for (const [chain, parent] of [
    [input, "INPUT"],
    [output, "OUTPUT"],
    ...(access ? ([[forward, "FORWARD"]] as const) : []),
  ] as const) {
    // The prepare step refuses an existing chain without our on-disk ownership receipt.
    up.push(`iptables -w 5 -N ${chain} 2>/dev/null || iptables -w 5 -S ${chain} >/dev/null`);
    up.push(`iptables -w 5 -F ${chain}`);
    const jump = `${parent} -m comment --comment ${comment} -j ${chain}`;
    up.push(`iptables -w 5 -C ${jump} 2>/dev/null || iptables -w 5 -I ${jump}`);
    down.push(`if iptables -w 5 -C ${jump} 2>/dev/null; then iptables -w 5 -D ${jump}; fi`);
    down.push(
      `if iptables -w 5 -S ${chain} >/dev/null 2>&1; then iptables -w 5 -F ${chain} && iptables -w 5 -X ${chain}; fi`,
    );
  }
  for (const peer of peers) {
    up.push(
      `iptables -w 5 -A ${input} -s ${peer.endpoint}/32 -p udp --dport ${listenPort} -j ACCEPT`,
    );
    up.push(
      `iptables -w 5 -A ${output} -d ${peer.endpoint}/32 -p udp --dport ${peer.listenPort} -j ACCEPT`,
    );
    if (!access) {
      up.push(`iptables -w 5 -A ${input} -i ${interfaceName} -s ${peer.privateIp}/32 -j ACCEPT`);
      up.push(`iptables -w 5 -A ${output} -o ${interfaceName} -d ${peer.privateIp}/32 -j ACCEPT`);
    }
  }
  if (access) {
    const original = "-m conntrack --ctstate NEW,ESTABLISHED --ctdir ORIGINAL";
    const reply = "-m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY";
    const incoming = `-i ${interfaceName}`;
    const outgoing = `-o ${interfaceName}`;
    const add = (chain: string, match: string, verdict = "ACCEPT") =>
      up.push(`iptables -w 5 -A ${chain} ${match} -j ${verdict}`);
    add(forward, `${incoming} ${outgoing}`, "DROP");
    for (const peer of access.incoming) {
      add(input, `${incoming} -s ${peer}/32 -d ${access.privateIp}/32 ${original}`);
      add(output, `${outgoing} -s ${access.privateIp}/32 -d ${peer}/32 ${reply}`);
      add(
        forward,
        `${incoming} -s ${peer}/32 ${original} --ctorigdst ${access.privateIp}/32`,
        "RETURN",
      );
      add(
        forward,
        `${outgoing} -d ${peer}/32 ${reply} --ctorigdst ${access.privateIp}/32`,
        "RETURN",
      );
    }
    for (const peer of access.outgoing) {
      add(output, `${outgoing} -s ${access.privateIp}/32 -d ${peer}/32 ${original}`);
      add(input, `${incoming} -s ${peer}/32 -d ${access.privateIp}/32 ${reply}`);
      add(forward, `${outgoing} -d ${peer}/32 ${original}`, "RETURN");
      add(forward, `${incoming} -s ${peer}/32 ${reply}`, "RETURN");
    }
    add(input, incoming, "DROP");
    add(output, outgoing, "DROP");
    add(forward, incoming, "DROP");
    add(forward, outgoing, "DROP");
  }
  return answered({
    up,
    down,
    inspect: "iptables-save",
    ...(access
      ? {
          snapshot: `python3 -c ${shellQuote(MANAGED_IPTABLES_SNAPSHOT)} ${shellQuote(JSON.stringify({ identity }))}`,
        }
      : {}),
  });
}
