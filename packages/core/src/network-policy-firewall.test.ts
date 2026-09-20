import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { managedNetworkFirewall, type ManagedFirewallAccess } from "./host-firewall";
import { shellSplitWords } from "./shell-split";

const identity = "a".repeat(32);
const iface = "oswg" + "a".repeat(10);
const prefix = `OSWG_${identity.slice(0, 16)}_`;
const peer = { endpoint: "192.0.2.2", listenPort: 51821, privateIp: "10.244.0.2" };
const local = "10.244.0.1";
const baseChains = ["input", "output"].map((hook) => ({
  chain: {
    family: "inet",
    table: "filter",
    name: hook,
    hook,
    type: "filter",
    prio: 0,
    policy: "accept",
  },
}));
const pythonAvailable = (() => {
  try {
    execFileSync("python3", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

function firewall(manager: "iptables" | "nftables" | "none", access: ManagedFirewallAccess) {
  const result = managedNetworkFirewall(manager, identity, iface, 51820, [peer], access);
  if (!result.supported) throw new Error(result.reason);
  return result.value;
}

// Execute the shipped nft program against a ruleset fixture; capture its atomic batch.
// No firewall command or registered server is accessed by these tests.
function nft(command: string, rows: unknown[], batch = false) {
  const args = shellSplitWords(command);
  const program = `import subprocess, types, json\nbatches = []\ndef fixture(args, **kwargs):\n if args == ['nft', '-j', 'list', 'ruleset']: output = json.dumps({'nftables': ${JSON.stringify(rows)}})\n elif args == ['nft', '-f', '-']: batches.append(kwargs['input']); output = ''\n else: raise AssertionError(args)\n return types.SimpleNamespace(returncode=0, stdout=output, stderr='')\nsubprocess.run = fixture\n`;
  // Use JSON at the boundary instead of interpreting fixture values as Python literals.
  const prelude = program.replace(
    JSON.stringify(rows),
    `json.loads(${JSON.stringify(JSON.stringify(rows))})`,
  );
  return execFileSync(
    "python3",
    ["-c", prelude + args[2] + (batch ? "\nprint(json.dumps(batches))" : ""), ...args.slice(3)],
    { encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

type Packet = {
  ingress?: string;
  egress?: string;
  source: string;
  destination: string;
  originalDestination?: string;
  direction: "original" | "reply";
  state: "new" | "established" | "related";
  protocol?: string;
  port?: number;
};
type Rule = { matches: Array<[keyof Packet, string[]]>; verdict: string };

// A small packet evaluator makes the assertions about traffic, not generated-string equality.
// It rejects unrecognized expressions so an unsupported rule cannot silently pass a test.
function parseRule(tokens: string[], manager: "iptables" | "nftables"): Rule {
  const matches: Rule["matches"] = [];
  let verdict = "";
  const add = (key: keyof Packet, value: string) =>
    matches.push([key, value.replace(/\/32$/, "").toLowerCase().split(",")]);
  while (tokens.length) {
    const token = tokens.shift()!;
    if (manager === "iptables") {
      const keys: Record<string, keyof Packet> = {
        "-i": "ingress",
        "-o": "egress",
        "-s": "source",
        "-d": "destination",
        "-p": "protocol",
        "--dport": "port",
        "--ctdir": "direction",
        "--ctstate": "state",
        "--ctorigdst": "originalDestination",
      };
      if (keys[token]) add(keys[token]!, tokens.shift()!);
      else if (token === "-m") {
        expect(tokens.shift()).toBe("conntrack");
      } else if (token === "-j") verdict = tokens.shift()!.toLowerCase();
      else throw new Error(`Unrecognized iptables match: ${token}`);
    } else if (token === "iifname" || token === "oifname") {
      add(token === "iifname" ? "ingress" : "egress", tokens.shift()!);
    } else if (token === "ip") {
      const field = tokens.shift();
      if (field !== "saddr" && field !== "daddr") throw new Error(`Unknown IP field: ${field}`);
      add(field === "saddr" ? "source" : "destination", tokens.shift()!);
    } else if (token === "udp") {
      add("protocol", "udp");
      expect(tokens.shift()).toBe("dport");
      add("port", tokens.shift()!);
    } else if (token === "ct") {
      const field = tokens.shift();
      if (field === "direction") add("direction", tokens.shift()!);
      else if (field === "original") {
        expect(tokens.splice(0, 2)).toEqual(["ip", "daddr"]);
        add("originalDestination", tokens.shift()!);
      } else if (field === "state") {
        expect(tokens.shift()).toBe("{");
        const states: string[] = [];
        while (tokens[0] !== "}") states.push(tokens.shift()!.replace(",", ""));
        tokens.shift();
        matches.push(["state", states]);
      } else throw new Error(`Unknown conntrack field: ${field}`);
    } else if (["accept", "return", "drop"].includes(token)) verdict = token;
    else throw new Error(`Unrecognized nftables match: ${token}`);
  }
  expect(verdict).not.toBe("");
  return { matches, verdict };
}

function compiled(manager: "iptables" | "nftables", access: ManagedFirewallAccess) {
  const rules = firewall(manager, access);
  const commands: string[] =
    manager === "iptables"
      ? rules.up
      : JSON.parse(nft(rules.up[0]!, baseChains, true))[0]
          .trim()
          .split("\n");
  const chains: Record<string, Rule[]> = { I: [], O: [], F: [] };
  for (const command of commands) {
    const words = shellSplitWords(command);
    const chainIndex =
      manager === "iptables" && words[3] === "-A"
        ? 4
        : manager === "nftables" && words.slice(0, 4).join(" ") === "add rule inet filter"
          ? 4
          : -1;
    if (chainIndex < 0 || !words[chainIndex]!.startsWith(prefix)) continue;
    chains[words[chainIndex]!.slice(-1)]!.push(parseRule(words.slice(chainIndex + 1), manager));
  }
  return (chain: "I" | "O" | "F", packet: Packet) => {
    const rule = chains[chain]!.find((rule) =>
      rule.matches.every(([key, values]) => values.includes(String(packet[key]))),
    );
    return rule?.verdict ?? "return";
  };
}

describe.each(["iptables", "nftables"] as const)("managed %s connection policy", (manager) => {
  it.skipIf(manager === "nftables" && !pythonAvailable)(
    "allows an outgoing connection and its replies, while denying reverse initiation and removed peers",
    () => {
      const decide = compiled(manager, {
        privateIp: local,
        incoming: [],
        outgoing: [peer.privateIp],
      });
      const outgoing: Packet = {
        egress: iface,
        source: local,
        destination: peer.privateIp,
        state: "new",
        direction: "original",
      };
      const incoming: Packet = {
        ingress: iface,
        source: peer.privateIp,
        destination: local,
        state: "new",
        direction: "original",
      };
      expect(decide("O", outgoing)).toBe("accept");
      expect(decide("O", { ...outgoing, state: "established" })).toBe("accept");
      expect(decide("I", { ...incoming, direction: "reply", state: "established" })).toBe("accept");
      expect(decide("I", { ...incoming, direction: "reply", state: "related" })).toBe("accept");
      expect(decide("I", incoming)).toBe("drop");
      expect(decide("I", { ...incoming, state: "established" })).toBe("drop");
      expect(decide("O", { ...outgoing, destination: "10.244.0.3" })).toBe("drop");
      expect(
        decide("I", {
          ...incoming,
          source: "10.244.0.3",
          direction: "reply",
          state: "established",
        }),
      ).toBe("drop");
      expect(decide("I", { ...incoming, ingress: "eth0", source: "203.0.113.8" })).toBe("return");
      expect(decide("O", { ...outgoing, egress: "eth0", destination: "203.0.113.8" })).toBe(
        "return",
      );
      expect(
        decide("I", {
          ...incoming,
          ingress: "eth0",
          source: peer.endpoint,
          protocol: "udp",
          port: 51820,
        }),
      ).toBe("accept");
      expect(
        decide("O", {
          ...outgoing,
          egress: "eth0",
          destination: peer.endpoint,
          protocol: "udp",
          port: peer.listenPort,
        }),
      ).toBe("accept");
    },
  );

  it.skipIf(manager === "nftables" && !pythonAvailable)(
    "protects host and published container ports and forbids using a hub as a transit router",
    () => {
      const decide = compiled(manager, {
        privateIp: local,
        incoming: [peer.privateIp],
        outgoing: [],
      });
      const incoming: Packet = {
        ingress: iface,
        source: peer.privateIp,
        destination: local,
        state: "new",
        direction: "original",
      };
      const reply: Packet = {
        egress: iface,
        source: local,
        destination: peer.privateIp,
        state: "established",
        direction: "reply",
      };
      expect(decide("I", incoming)).toBe("accept");
      expect(decide("O", reply)).toBe("accept");
      expect(decide("O", { ...reply, direction: "original" })).toBe("drop");
      expect(
        decide("F", {
          ...incoming,
          egress: "docker0",
          destination: "172.17.0.2",
          originalDestination: local,
        }),
      ).toBe("return");
      expect(
        decide("F", {
          ...reply,
          ingress: "docker0",
          source: "172.17.0.2",
          originalDestination: local,
        }),
      ).toBe("return");
      expect(
        decide("F", {
          ...incoming,
          egress: "docker0",
          destination: "172.17.0.2",
          originalDestination: "10.244.0.3",
        }),
      ).toBe("drop");
      expect(
        decide("F", {
          ...incoming,
          egress: iface,
          destination: "10.244.0.3",
          originalDestination: local,
        }),
      ).toBe("drop");
      expect(decide("F", { ...reply, ingress: iface, originalDestination: local })).toBe("drop");
      expect(
        decide("F", {
          ...reply,
          ingress: "docker0",
          source: "172.17.0.2",
          direction: "original",
          state: "new",
        }),
      ).toBe("drop");
    },
  );
});

it("gives unfiltered hosts an owned stateful firewall without changing legacy full-mesh setup", () => {
  expect(firewall("none", { privateIp: local, incoming: [], outgoing: [] })).toEqual(
    firewall("iptables", { privateIp: local, incoming: [], outgoing: [] }),
  );
  expect(managedNetworkFirewall("none", identity, iface, 51820, [peer])).toMatchObject({
    supported: true,
    value: { up: [], down: [] },
  });
});

it.skipIf(!pythonAvailable)(
  "snapshots only owned nft rules, ignores counters, and refuses a bypass before the policy",
  () => {
    const rules = firewall("nftables", {
      privateIp: local,
      incoming: [peer.privateIp],
      outgoing: [],
    });
    const ownedChains = ["I", "O", "F"].map((suffix) => ({
      chain: { family: "inet", table: "filter", name: prefix + suffix, handle: 50 },
    }));
    const jumps = ["input", "output"].map((chain, index) => ({
      rule: {
        family: "inet",
        table: "filter",
        chain,
        comment: `openship-network-${identity}-${index ? "O" : "I"}`,
        handle: index + 1,
        expr: [{ jump: { target: prefix + (index ? "O" : "I") } }],
      },
    }));
    const owned = {
      rule: {
        family: "inet",
        table: "filter",
        chain: prefix + "I",
        handle: 60,
        expr: [{ counter: { packets: 1, bytes: 50 } }, { drop: null }],
      },
    };
    const rows = [...baseChains, ...ownedChains, ...jumps, owned];
    const snapshot = nft(rules.snapshot!, rows);
    expect(
      nft(rules.snapshot!, [
        ...baseChains,
        ...ownedChains,
        ...jumps,
        {
          rule: {
            ...owned.rule,
            handle: 900,
            expr: [{ counter: { packets: 400, bytes: 20_000 } }, { drop: null }],
          },
        },
      ]),
    ).toBe(snapshot);
    expect(
      nft(rules.snapshot!, [
        ...baseChains,
        ...ownedChains,
        ...jumps,
        { rule: { ...owned.rule, expr: [{ accept: null }] } },
      ]),
    ).not.toBe(snapshot);
    expect(() =>
      nft(rules.snapshot!, [
        ...baseChains,
        ...ownedChains,
        { rule: { family: "inet", table: "filter", chain: "input", expr: [{ accept: null }] } },
        ...jumps,
        owned,
      ]),
    ).toThrow();
    const removed = JSON.parse(nft(rules.down[0]!, rows, true))[0] as string;
    expect(removed).toContain(`delete chain inet filter ${prefix}F`);
    expect(removed).not.toMatch(/flush (table|ruleset)|delete table/);
  },
);

it.skipIf(!pythonAvailable)(
  "requires owned iptables policy jumps ahead of general host accepts",
  () => {
    const command = firewall("iptables", {
      privateIp: local,
      incoming: [],
      outgoing: [peer.privateIp],
    }).snapshot!;
    const args = shellSplitWords(command);
    const snapshot = (bypass: boolean) => {
      const prelude = `import json, subprocess, types\ndef fixture(args, **kwargs):\n chain = args[-1]\n parents = {'INPUT':'I', 'OUTPUT':'O', 'FORWARD':'F'}\n if chain in parents:\n  output = '-P ' + chain + ' ACCEPT\\n'\n  if ${bypass ? "True" : "False"}: output += '-A ' + chain + ' -m conntrack --ctstate ESTABLISHED -j ACCEPT\\n'\n  output += '-A ' + chain + ' -m comment --comment openship-network-${identity} -j ${prefix}' + parents[chain] + '\\n'\n else: output = '-N ' + chain + '\\n-A ' + chain + ' -i ${iface} -j DROP\\n'\n return types.SimpleNamespace(returncode=0, stdout=output, stderr='')\nsubprocess.run = fixture\n`;
      return execFileSync("python3", ["-c", prelude + args[2], ...args.slice(3)], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    };
    expect(Object.keys(JSON.parse(snapshot(false)))).toEqual(["F", "I", "O"]);
    expect(() => snapshot(true)).toThrow();
  },
);
