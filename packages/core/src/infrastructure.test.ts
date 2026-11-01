import { describe, expect, it } from "vitest";
import {
  infrastructureCidr,
  isInfrastructurePrivateIp,
  validateNativeCluster,
  selectClusterInterface,
  networkReportSucceeded,
  nativeNetworkSource,
  networkMemberProvider,
  type NativeClusterConfig,
  type ClusterNetworkReport,
} from "./infrastructure";

const config = (): NativeClusterConfig => ({
  name: "Production",
  network: { mode: "native", cidrs: ["10.20.0.0/24", "10.30.0.0/24"], mtu: 1400, probePort: 51821 },
  members: [
    { serverId: "one", providerId: "hetzner-dedicated", privateIp: "10.20.0.2" },
    { serverId: "two", providerId: "custom", privateIp: "10.30.0.2" },
  ],
});

describe("private infrastructure configuration", () => {
  it("keeps legacy routed networks custom unless provider and network reference both agree", () => {
    const value = config();
    expect(nativeNetworkSource(value)).toEqual({ providerId: "custom" });
    value.members = value.members.map((member) => ({
      ...member,
      providerId: "aws",
      networkRef: " vpc-a ",
    }));
    expect(nativeNetworkSource(value)).toEqual({ providerId: "aws", networkRef: "vpc-a" });
    value.members[1]!.networkRef = "vpc-b";
    expect(nativeNetworkSource(value)).toEqual({ providerId: "custom" });
    delete value.members[1]!.networkRef;
    expect(nativeNetworkSource(value)).toEqual({ providerId: "custom" });
    expect(() => validateNativeCluster(value)).not.toThrow();
  });
  it("uses explicit network context without rewriting historical member references", () => {
    const value = config();
    value.network.source = { providerId: "hetzner-dedicated", networkRef: " vswitch-new " };
    value.members[0]!.networkRef = "vswitch-old";
    expect(nativeNetworkSource(value)).toEqual({
      providerId: "hetzner-dedicated",
      networkRef: "vswitch-new",
    });
    expect(() => validateNativeCluster(value)).not.toThrow();
    expect(value.members[0]!.networkRef).toBe("vswitch-old");
    value.members[1]!.providerId = "aws";
    expect(() => validateNativeCluster(value)).toThrow("Use Custom");
    value.network.source = { providerId: "custom", networkRef: "routed-backbone" };
    expect(() => validateNativeCluster(value)).not.toThrow();
  });
  it("applies native provider limits to servers without known provider metadata, but not to managed tunnels", () => {
    const value = config();
    value.members.forEach((member) => {
      member.providerId = "custom";
    });
    value.network.source = { providerId: "hetzner-dedicated" };
    value.network.mtu = 1500;
    expect(() => validateNativeCluster(value)).toThrow("at most 1400");
    expect(networkMemberProvider(value.network, value.members[0]!)).toBe("hetzner-dedicated");
    expect(networkMemberProvider({ mode: "wireguard" }, { providerId: "hetzner-dedicated" })).toBe(
      "custom",
    );
    expect(nativeNetworkSource({ ...value, network: { mode: "wireguard" } })).toEqual({
      providerId: "custom",
    });
  });
  it("accepts routed private networks and mixed providers", () => {
    expect(() => validateNativeCluster(config())).not.toThrow();
  });
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "8.8.8.8",
    "169.254.169.254",
    "10.01.0.2",
    "10.0.0.2; whoami",
    "::1",
  ])("rejects non-private or ambiguous address %s", (address) => {
    expect(isInfrastructurePrivateIp(address)).toBe(false);
    const value = config();
    value.members[0]!.privateIp = address;
    expect(() => validateNativeCluster(value)).toThrow();
  });
  it("rejects host addresses used as CIDRs, overlaps, and broadcast addresses", () => {
    expect(infrastructureCidr("10.20.0.2/24")).toBeNull();
    const value = config();
    value.network.cidrs.push("10.20.0.0/25");
    expect(() => validateNativeCluster(value)).toThrow("overlap");
    value.network.cidrs.pop();
    value.members[0]!.privateIp = "10.20.0.255";
    expect(() => validateNativeCluster(value)).toThrow("usable");
  });
  it("rejects duplicate host entries and reused addresses", () => {
    const value = config();
    value.members[1]!.serverId = "one";
    expect(() => validateNativeCluster(value)).toThrow("once");
    value.members[1]!.serverId = "two";
    value.members[1]!.privateIp = value.members[0]!.privateIp;
    expect(() => validateNativeCluster(value)).toThrow("unique");
  });
  it("requires the exact private address on an active host interface with enough MTU", () => {
    const host = {
      hostIdentity: "host:a",
      interfaces: [
        {
          name: "eth1.4000",
          mtu: 1400,
          up: true,
          kind: "vlan",
          addresses: [{ address: "10.20.0.2", prefixLength: 24 }],
        },
      ],
    };
    expect(selectClusterInterface(host, config().members[0]!, 1400).name).toBe("eth1.4000");
    expect(() => selectClusterInterface(host, config().members[1]!, 1400)).toThrow("address");
    expect(() => selectClusterInterface(host, config().members[0]!, 1500)).toThrow("MTU");
    host.interfaces[0]!.up = false;
    expect(() => selectClusterInterface(host, config().members[0]!, 1400)).toThrow();
  });
  it("enforces the vSwitch MTU while allowing other providers to verify larger packets", () => {
    const value = config();
    value.network.mtu = 1500;
    expect(() => validateNativeCluster(value)).toThrow("at most 1400");
    value.members[0]!.providerId = "custom";
    expect(() => validateNativeCluster(value)).not.toThrow();
    const host = {
      hostIdentity: "host:a",
      interfaces: [
        {
          name: "eth1.4000",
          mtu: 1500,
          up: true,
          kind: "vlan",
          addresses: [{ address: "10.20.0.2", prefixLength: 24 }],
        },
      ],
    };
    expect(() => selectClusterInterface(host, config().members[0]!, 1400)).toThrow(
      "Configure the Robot vSwitch interface",
    );
    expect(selectClusterInterface(host, value.members[0]!, 1400).mtu).toBe(1500);
  });
  it("does not accept an ordinary Docker bridge as a shared private network", () => {
    const host = {
      hostIdentity: "host:a",
      interfaces: [
        {
          name: "docker0",
          mtu: 1500,
          up: true,
          kind: "bridge",
          addresses: [{ address: "10.20.0.2", prefixLength: 24 }],
        },
      ],
    };
    expect(() => selectClusterInterface(host, config().members[0]!, 1400)).toThrow();
  });
});

it("requires successful TCP, UDP, and MTU checks for every directed pair", () => {
  const report: ClusterNetworkReport = {
    stage: "complete",
    hosts: ["one", "two"].map((serverId) => ({
      serverId,
      ok: true,
      mtu: 1400,
      interfaceName: "eth1",
      code: null,
      message: null,
    })),
    peers: [
      {
        sourceServerId: "one",
        targetServerId: "two",
        tcp: true,
        udp: true,
        mtu: true,
        latencyMs: 1,
        message: null,
      },
    ],
  };
  expect(networkReportSucceeded(report, ["one", "two"])).toBe(false);
  report.peers.push({ ...report.peers[0]!, sourceServerId: "two", targetServerId: "one" });
  expect(networkReportSucceeded(report, ["one", "two"])).toBe(true);
  report.handshakes = report.peers.map((peer) => ({
    sourceServerId: peer.sourceServerId,
    targetServerId: peer.targetServerId,
    endpoint: "192.0.2.2",
    port: 51820,
    ok: true,
    lastHandshakeAt: new Date().toISOString(),
  }));
  expect(networkReportSucceeded(report, ["one", "two"])).toBe(true);
  report.handshakes[0]!.ok = false;
  expect(networkReportSucceeded(report, ["one", "two"])).toBe(false);
  report.handshakes.pop();
  expect(networkReportSucceeded(report, ["one", "two"])).toBe(false);
  delete report.handshakes;
  report.peers[1]!.mtu = false;
  expect(networkReportSucceeded(report, ["one", "two"])).toBe(false);
  report.peers[1] = { ...report.peers[0]! };
  expect(networkReportSucceeded(report, ["one", "two"])).toBe(false);
});

it("verifies restrictions as well as allowed paths, including isolated members", () => {
  const ids = ["hub", "spoke", "isolated"];
  const access = {
    version: 1 as const,
    rules: [{ sourceServerId: "hub", targetServerId: "spoke" }],
  };
  const report: ClusterNetworkReport = {
    stage: "complete",
    hosts: ids.map((serverId) => ({
      serverId,
      ok: true,
      mtu: 1400,
      interfaceName: "oswg",
      code: null,
      message: null,
    })),
    peers: ids.flatMap((sourceServerId) =>
      ids
        .filter((id) => id !== sourceServerId)
        .map((targetServerId) => {
          const allowed = sourceServerId === "hub" && targetServerId === "spoke";
          return {
            sourceServerId,
            targetServerId,
            tcp: allowed,
            udp: allowed,
            mtu: allowed,
            reachable: allowed,
            expectedAccess: allowed ? ("allow" as const) : ("deny" as const),
            policyPassed: true,
            latencyMs: allowed ? 1 : null,
            message: null,
          };
        }),
    ),
    handshakes: [
      ["hub", "spoke"],
      ["spoke", "hub"],
    ].map(([sourceServerId, targetServerId]) => ({
      sourceServerId: sourceServerId!,
      targetServerId: targetServerId!,
      ok: true,
      endpoint: "192.0.2.1",
      port: 51820,
      lastHandshakeAt: new Date().toISOString(),
    })),
  };
  expect(networkReportSucceeded(report, ids, access)).toBe(true);
  expect(networkReportSucceeded(report, ids)).toBe(false);
  const reverse = report.peers.find(
    (peer) => peer.sourceServerId === "spoke" && peer.targetServerId === "hub",
  )!;
  reverse.reachable = true;
  expect(networkReportSucceeded(report, ids, access)).toBe(false);
  delete reverse.reachable;
  expect(networkReportSucceeded(report, ids, access)).toBe(false); // SSH failure is not proof of isolation.
  reverse.reachable = false;
  reverse.policyPassed = false;
  expect(networkReportSucceeded(report, ids, access)).toBe(false);
  reverse.policyPassed = true;
  reverse.tcp = true;
  expect(networkReportSucceeded(report, ids, access)).toBe(false);
  reverse.tcp = false;
  report.handshakes!.pop();
  expect(networkReportSucceeded(report, ids, access)).toBe(false); // UDP transport remains bidirectional.
  report.handshakes = [];
  report.peers = report.peers.map((peer) => ({
    ...peer,
    tcp: false,
    udp: false,
    mtu: false,
    reachable: false,
    expectedAccess: "deny",
    policyPassed: true,
  }));
  expect(networkReportSucceeded(report, ids, { version: 1, rules: [] })).toBe(true);
  report.peers.pop();
  expect(networkReportSucceeded(report, ids, { version: 1, rules: [] })).toBe(false);
});
