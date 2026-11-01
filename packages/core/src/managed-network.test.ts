import { describe, expect, it } from "vitest";
import {
  allocateManagedSubnet,
  allocateManagedAddresses,
  managedInterfaceName,
  validateWireGuardCluster,
  validWireGuardEndpoint,
  type ManagedNetworkObservation,
  type WireGuardClusterConfig,
} from "./managed-network";
import { managedNetworkFirewall } from "./host-firewall";

const observation = (
  overrides: Partial<ManagedNetworkObservation> = {},
): ManagedNetworkObservation => ({
  hostIdentity: "host:a",
  fingerprint: "a",
  interfaces: [],
  routes: [],
  reservedIps: [],
  configHash: null,
  publicKey: null,
  packages: [],
  firewall: "iptables",
  transportMtu: 1500,
  ...overrides,
});
function config(): WireGuardClusterConfig {
  const managedId = "abcdef0123456789abcdef0123456789";
  return {
    name: "Mesh",
    network: {
      mode: "wireguard",
      managedId,
      interfaceName: managedInterfaceName(managedId),
      cidrs: ["10.244.0.0/24"],
      mtu: 1400,
      probePort: 45876,
    },
    members: [1, 2].map((index) => ({
      serverId: `s${index}`,
      providerId: "custom",
      privateIp: `10.244.0.${index}`,
      endpoint: `192.0.2.${index}`,
      listenPort: 51820,
    })),
  };
}
describe("managed network allocation", () => {
  it("skips observed routes, Docker subnets, interface prefixes, DNS and reserved cluster ranges", () => {
    const host = observation({
      routes: ["10.244.0.0/24"],
      interfaces: [
        {
          name: "docker0",
          mtu: 1500,
          up: false,
          kind: "bridge",
          addresses: [{ address: "10.244.1.1", prefixLength: 24 }],
        },
      ],
      reservedIps: ["10.244.2.53"],
    });
    expect(allocateManagedSubnet([host], undefined, ["10.244.3.0/24"])).toBe("10.244.4.0/24");
    for (let index = 0; index < 4; index++)
      expect(() =>
        allocateManagedSubnet([host], `10.244.${index}.0/24`, ["10.244.3.0/24"]),
      ).toThrow(/overlaps/);
  });
  it("requires canonical, private and sufficiently large requested ranges", () => {
    for (const cidr of [
      "10.20.1.1/24",
      "10.0.0.0/8",
      "10.20.0.0/28",
      "192.0.2.0/24",
      "10.244.0.1",
      "0.0.0.0/0",
    ])
      expect(() => allocateManagedSubnet([], cidr)).toThrow();
    expect(allocateManagedSubnet([], "172.22.0.0/16")).toBe("172.22.0.0/16");
  });
  it("retains member addresses and does not reuse a departing member's address before cleanup", () => {
    const previous = config().members;
    expect([...allocateManagedAddresses("10.244.0.0/24", ["s3", "s1"], previous)]).toEqual([
      ["s1", "10.244.0.1"],
      ["s3", "10.244.0.3"],
    ]);
    expect([...allocateManagedAddresses("10.244.0.0/24", ["s1", "s3"], previous)]).toEqual([
      ...allocateManagedAddresses("10.244.0.0/24", ["s3", "s1"], previous),
    ]);
    expect(() => allocateManagedAddresses("10.244.0.0/24", ["s1", "s1"])).toThrow();
    expect(() =>
      allocateManagedAddresses("10.244.0.0/24", ["s1", "s2"], [previous[0]!, previous[0]!]),
    ).toThrow();
  });
});
describe("managed transport validation", () => {
  it("accepts public and private transport IPs but rejects non-unicast or malformed addresses", () => {
    expect(validWireGuardEndpoint("192.0.2.3")).toBe(true);
    expect(validWireGuardEndpoint("10.20.0.3")).toBe(true);
    for (const ip of [
      "0.0.0.0",
      "127.0.0.1",
      "169.254.1.1",
      "224.0.0.1",
      "255.255.255.255",
      "1.2.3.999",
      "01.2.3.4",
      "host.test",
    ])
      expect(validWireGuardEndpoint(ip)).toBe(false);
  });
  it("fences interface identity and rejects duplicate endpoints, invalid providers and probe-port collisions", () => {
    expect(() => validateWireGuardCluster(config())).not.toThrow();
    const wrong = config();
    wrong.network.interfaceName = "eth0";
    expect(() => validateWireGuardCluster(wrong)).toThrow(/interface/);
    const duplicate = config();
    duplicate.members[1]!.endpoint = duplicate.members[0]!.endpoint;
    expect(() => validateWireGuardCluster(duplicate)).toThrow(/distinct/);
    duplicate.members[1]!.listenPort = 51822;
    expect(() => validateWireGuardCluster(duplicate)).not.toThrow();
    duplicate.members[0]!.providerId = "unknown" as never;
    expect(() => validateWireGuardCluster(duplicate)).toThrow(/provider/);
    const collision = config();
    collision.network.probePort = collision.members[0]!.listenPort;
    expect(() => validateWireGuardCluster(collision)).toThrow(/distinct/);
  });
  it("scopes firewall changes to owned chains and listed peers", () => {
    const value = config();
    const result = managedNetworkFirewall(
      "iptables",
      value.network.managedId,
      value.network.interfaceName,
      51820,
      value.members.slice(1),
    );
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    const commands = [...result.value.up, ...result.value.down].join("\n");
    expect(commands).toContain("--comment openship-network-");
    expect(commands).toContain("-s 192.0.2.2/32 -p udp --dport 51820");
    expect(commands).toContain("-i oswgabcdef0123 -s 10.244.0.2/32");
    expect(commands).not.toMatch(
      /iptables-restore|-F INPUT|-F OUTPUT|-P INPUT|-P OUTPUT|0\.0\.0\.0\/0/,
    );
    expect(
      managedNetworkFirewall(
        "ufw",
        value.network.managedId,
        value.network.interfaceName,
        51820,
        value.members,
      ).supported,
    ).toBe(false);
    expect(
      managedNetworkFirewall(
        "iptables",
        value.network.managedId,
        "eth0; reboot",
        51820,
        value.members,
      ).supported,
    ).toBe(false);
  });
});
