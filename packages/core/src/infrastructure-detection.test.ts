import { describe, expect, it } from "vitest";
import {
  privateInterfaceChoices,
  suggestNativeClusterConfig,
  validateNativeCluster,
  type NativeClusterConfig,
  type NetworkHostObservation,
} from "./infrastructure";

const host = (address: string, prefixLength = 24, name = "eth1"): NetworkHostObservation => ({
  hostIdentity: `host:${address}`,
  interfaces: [{ name, mtu: 1400, up: true, kind: "vlan", addresses: [{ address, prefixLength }] }],
});
const config = (): NativeClusterConfig => ({
  name: "Production",
  network: { mode: "native", cidrs: ["10.20.0.0/24"], mtu: 1400, probePort: 51821 },
  members: [
    {
      serverId: "one",
      providerId: "hetzner-dedicated",
      privateIp: "10.20.1.10",
      networkRef: "vswitch-1",
    },
    { serverId: "two", providerId: "hetzner-dedicated", privateIp: "10.20.2.10" },
    { serverId: "three", providerId: "ovh", privateIp: "10.20.3.10" },
  ],
});
const observations = () => ({
  one: host("10.20.1.10", 24, "eth1.4000"),
  two: host("10.20.2.10", 24, "eth1.4000"),
  three: host("10.20.3.10"),
});

describe("private network detection", () => {
  it("uses the network provider's MTU limit when server provider metadata is unknown", () => {
    const input = config();
    input.network.source = { providerId: "hetzner-dedicated", networkRef: "vswitch-a" };
    input.network.mtu = 1500;
    input.members.forEach((member) => {
      member.providerId = "custom";
    });
    const found = observations();
    Object.values(found).forEach((host) => {
      host.interfaces[0]!.mtu = 1500;
    });
    const result = suggestNativeClusterConfig(input, found);
    expect(result.network.mtu).toBe(1400);
    expect(result.network.source).toEqual(input.network.source);
    expect(result.members.map((member) => member.providerId)).toEqual([
      "custom",
      "custom",
      "custom",
    ]);
  });
  it("uses the real interface masks for the three entered addresses without inventing a /16", () => {
    const input = config();
    const original = structuredClone(input);
    const result = suggestNativeClusterConfig(input, observations());
    expect(result.network.cidrs).toEqual(["10.20.1.0/24", "10.20.2.0/24", "10.20.3.0/24"]);
    expect(result.members[0]).toEqual({ ...input.members[0], interfaceName: "eth1.4000" });
    expect(result.members[2]?.providerId).toBe("ovh");
    expect(input).toEqual(original);
    expect(() => validateNativeCluster(result)).not.toThrow();
  });

  it("fills empty member fields and deduplicates a shared subnet", () => {
    const input = config();
    input.members.forEach((member) => {
      member.privateIp = "";
    });
    const result = suggestNativeClusterConfig(input, {
      one: host("10.20.0.2"),
      two: host("10.20.0.3"),
      three: host("10.20.0.4"),
    });
    expect(result.network.cidrs).toEqual(["10.20.0.0/24"]);
    expect(result.members.map((member) => member.privateIp)).toEqual([
      "10.20.0.2",
      "10.20.0.3",
      "10.20.0.4",
    ]);
  });

  it("preserves an explicitly entered routed range that already covers the addresses", () => {
    const input = config();
    input.network.cidrs = ["10.20.0.0/16"];
    expect(suggestNativeClusterConfig(input, observations()).network.cidrs).toEqual([
      "10.20.0.0/16",
    ]);
  });

  it("deduplicates contained observed subnets without manufacturing a covering range", () => {
    const found = observations();
    found.one = host("10.20.1.10", 16);
    expect(suggestNativeClusterConfig(config(), found).network.cidrs).toEqual(["10.20.0.0/16"]);
  });

  it("requires a choice for ambiguous interfaces, while retaining an existing matching choice", () => {
    const found = host("10.20.1.10");
    found.interfaces.push(...host("10.30.1.10", 24, "eth2").interfaces);
    const input = config();
    input.members[0]!.privateIp = "";
    expect(suggestNativeClusterConfig(input, { one: found }).members[0]?.privateIp).toBe("");
    input.members[0]!.privateIp = "10.30.1.10";
    const result = suggestNativeClusterConfig(input, { one: found });
    expect(result.members[0]?.interfaceName).toBe("eth2");
    expect(result.network.cidrs).toEqual(["10.30.1.0/24"]);
  });

  it("does not overwrite other members or fabricate settings for a failed inspection", () => {
    const input = config();
    input.members[1]!.privateIp = "10.50.0.10";
    const result = suggestNativeClusterConfig(input, observations(), ["one"]);
    expect(result.members[0]?.interfaceName).toBe("eth1.4000");
    expect(result.members[1]).toEqual(input.members[1]);
    expect(result.members[2]).toEqual(input.members[2]);
    expect(suggestNativeClusterConfig(input, {})).toBe(input);
  });

  it("ignores loopback, Docker bridges, public addresses, and inactive interfaces", () => {
    const interfaces = [
      ...host("127.0.0.1", 8, "lo").interfaces,
      ...host("172.17.0.1", 16, "docker0").interfaces,
      ...host("172.18.0.1", 16, "br-a1b2c3").interfaces,
      ...host("10.10.0.1", 24, "veth123").interfaces,
      ...host("192.0.2.10", 24, "eth0").interfaces,
      ...host("10.20.0.2").interfaces.map((nic) => ({ ...nic, up: false })),
    ];
    expect(privateInterfaceChoices(interfaces)).toEqual([]);
  });

  it.each([31, 32, 0, 33, 24.5])("does not guess a subnet for unsupported prefix %s", (prefix) => {
    expect(privateInterfaceChoices(host("10.20.1.10", prefix).interfaces)[0]?.cidr).toBeNull();
  });

  it("calculates non-/24 masks correctly and rejects ranges outside private space", () => {
    expect(privateInterfaceChoices(host("192.168.10.70", 27).interfaces)[0]?.cidr).toBe(
      "192.168.10.64/27",
    );
    expect(privateInterfaceChoices(host("172.16.1.10", 8).interfaces)[0]?.cidr).toBeNull();
    expect(privateInterfaceChoices(host("10.20.0.255").interfaces)[0]?.cidr).toBeNull();
  });

  it("keeps /32 addresses usable with an explicitly supplied routed range", () => {
    const input = config();
    input.network.cidrs = ["10.20.0.0/16"];
    const found = observations();
    found.one = host("10.20.1.10", 32);
    const result = suggestNativeClusterConfig(input, found);
    expect(result.members[0]?.interfaceName).toBe("eth1");
    expect(result.network.cidrs).toEqual(["10.20.0.0/16"]);
    expect(() => validateNativeCluster(result)).not.toThrow();
  });

  it("only lowers verification MTU to supported observed limits", () => {
    const input = config();
    input.network.mtu = 1500;
    const found = observations();
    found.three.interfaces[0]!.mtu = 1300;
    expect(suggestNativeClusterConfig(input, found).network.mtu).toBe(1300);
    input.network.mtu = 1280;
    expect(suggestNativeClusterConfig(input, found).network.mtu).toBe(1280);
  });
});
