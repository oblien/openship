import { describe, expect, it } from "vitest";
import { networkFirewallRules, networkFirewallTemplate } from "./network-firewall";
import { managedNetworkFirewall } from "./host-firewall";
import { setNetworkConnection } from "./network-access";

const members = [
  { serverId: "a", endpoint: "192.0.2.10", listenPort: 51820, privateIp: "10.244.0.1" },
  { serverId: "b", endpoint: "203.0.113.20", listenPort: 53000, privateIp: "10.244.0.2" },
  { serverId: "c", endpoint: "198.51.100.30", listenPort: 54000, privateIp: "10.244.0.3" },
];

describe("provider firewall templates", () => {
  it("removes disconnected peers while keeping both transport directions for a one-way private connection", () => {
    const access = setNetworkConnection(
      { version: 1, rules: [] },
      ["a", "b", "c"],
      "a",
      "b",
      "forward",
    );
    const scope = { mode: "wireguard" as const, access };
    for (const serverId of ["a", "b"]) {
      const { rules } = networkFirewallRules(members, serverId, scope);
      expect(rules.map((rule) => rule.direction)).toEqual(["inbound", "outbound"]);
      expect(rules.every((rule) => rule.peerServerId !== "c")).toBe(true);
      expect(networkFirewallTemplate(members, serverId, scope)).not.toContain("198.51.100.30");
    }
    expect(networkFirewallRules(members, "c", scope)).toEqual({ rules: [], pendingServerIds: [] });
    expect(
      networkFirewallTemplate(
        [members[0]!, members[1]!, { ...members[2]!, endpoint: undefined }],
        "a",
        scope,
      ),
    ).not.toBeNull();
  });
  it("scopes both directions to peers and uses the destination server's port", () => {
    const result = networkFirewallRules(members, "a");
    expect(result.pendingServerIds).toEqual([]);
    expect(result.rules).toHaveLength(4);
    expect(result.rules).toContainEqual({
      serverId: "a",
      peerServerId: "b",
      direction: "inbound",
      action: "allow",
      protocol: "udp",
      source: "203.0.113.20/32",
      sourcePort: "any",
      destination: "192.0.2.10/32",
      destinationPort: 51820,
    });
    expect(result.rules).toContainEqual({
      serverId: "a",
      peerServerId: "b",
      direction: "outbound",
      action: "allow",
      protocol: "udp",
      source: "192.0.2.10/32",
      sourcePort: "any",
      destination: "203.0.113.20/32",
      destinationPort: 53000,
    });
    expect(result.rules.every((rule) => rule.serverId !== rule.peerServerId)).toBe(true);
    const template = networkFirewallTemplate(members, "a")!;
    expect(template.split("\n")).toHaveLength(5);
    expect(template).not.toMatch(/0\.0\.0\.0|10\.244|45876|tcp/);
    expect(template).toContain("outbound\tallow\tudp\t192.0.2.10/32\tany\t198.51.100.30/32\t54000");
  });

  it("matches the transport scope installed by the host firewall adapter", () => {
    const host = managedNetworkFirewall(
      "iptables",
      "a".repeat(32),
      "oswgaaaaaaaaaa",
      51820,
      members.slice(1),
    );
    expect(host.supported).toBe(true);
    if (!host.supported) throw new Error("Expected supported firewall");
    const script = host.value.up.join("\n");
    for (const rule of networkFirewallRules(members, "a").rules) {
      expect(script).toContain(
        rule.direction === "inbound"
          ? `-s ${rule.source} -p udp --dport ${rule.destinationPort}`
          : `-d ${rule.destination} -p udp --dport ${rule.destinationPort}`,
      );
    }
    expect(script).not.toContain("--sport");
  });

  it.each([undefined, "node.example.test", "::1", "127.0.0.1", "192.0.2.999"])(
    "does not copy an unresolved or invalid address (%s) as a complete template",
    (endpoint) => {
      const incomplete = [members[0]!, { ...members[1]!, endpoint }, members[2]!];
      expect(networkFirewallRules(incomplete, "a").pendingServerIds).toEqual(["b"]);
      expect(networkFirewallRules(incomplete, "a").rules).toHaveLength(2);
      expect(networkFirewallTemplate(incomplete, "a")).toBeNull();
      expect(networkFirewallRules(incomplete, "b").rules).toEqual([]);
    },
  );

  it.each([undefined, 0, 1023, 65536, 51820.5])(
    "does not invent a port when it is missing or invalid (%s)",
    (listenPort) => {
      const incomplete = [members[0]!, { ...members[1]!, listenPort }];
      expect(networkFirewallRules(incomplete, "a").rules).toEqual([]);
      expect(networkFirewallTemplate(incomplete, "a")).toBeNull();
    },
  );

  it("uses reachable private transport endpoints when supplied, without inferring a public IP", () => {
    const privateTransport = [members[0]!, { ...members[1]!, endpoint: "10.20.0.2" }];
    expect(networkFirewallRules(privateTransport, "a").rules[0]?.source).toBe("10.20.0.2/32");
  });

  it("does not produce a template for an unknown server or a fleet without peers", () => {
    expect(networkFirewallTemplate(members, "missing")).toBeNull();
    expect(networkFirewallTemplate([members[0]!], "a")).toBeNull();
  });

  it("uses private addresses and the selected probe port for native TCP/UDP checks and replies", () => {
    const nativeMembers = members.map((member) => ({ ...member, interfaceName: "enp7s0.4000" }));
    const scope = { mode: "native", probePort: 51999 } as const;
    const { rules, pendingServerIds } = networkFirewallRules(nativeMembers, "a", scope);
    expect(pendingServerIds).toEqual([]);
    expect(rules).toHaveLength(16);
    for (const protocol of ["tcp", "udp"] as const) {
      expect(rules).toContainEqual(
        expect.objectContaining({
          protocol,
          direction: "inbound",
          source: "10.244.0.2/32",
          sourcePort: "any",
          destination: "10.244.0.1/32",
          destinationPort: 51999,
          interfaceName: "enp7s0.4000",
        }),
      );
      expect(rules).toContainEqual(
        expect.objectContaining({
          protocol,
          direction: "outbound",
          reply: true,
          source: "10.244.0.1/32",
          sourcePort: 51999,
          destination: "10.244.0.2/32",
          destinationPort: "any",
        }),
      );
      expect(rules).toContainEqual(
        expect.objectContaining({
          protocol,
          direction: "inbound",
          reply: true,
          source: "10.244.0.2/32",
          sourcePort: 51999,
          destination: "10.244.0.1/32",
          destinationPort: "any",
        }),
      );
    }
    const template = networkFirewallTemplate(nativeMembers, "a", scope)!;
    expect(template).toContain("enp7s0.4000\treply");
    expect(template).not.toMatch(/192\.0\.2|203\.0\.113|198\.51\.100|51820|53000|54000/);
  });

  it("never substitutes a public endpoint for missing or invalid native private addresses", () => {
    const missing = [members[0]!, { ...members[1]!, privateIp: undefined }];
    const scope = { mode: "native", probePort: 51821 } as const;
    expect(networkFirewallTemplate(missing, "a", scope)).toBeNull();
    expect(
      networkFirewallTemplate(
        [members[0]!, { ...members[1]!, privateIp: "192.0.2.1" }],
        "a",
        scope,
      ),
    ).toBeNull();
    expect(networkFirewallTemplate(members, "a", { mode: "native", probePort: 0 })).toBeNull();
  });
});
