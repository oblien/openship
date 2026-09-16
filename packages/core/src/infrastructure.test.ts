import { describe, expect, it } from "vitest";
import {
  infrastructureCidr,
  isInfrastructurePrivateIp,
  validateNativeCluster,
  selectClusterInterface,
  networkReportSucceeded,
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
  report.peers[1]!.mtu = false;
  expect(networkReportSucceeded(report, ["one", "two"])).toBe(false);
  report.peers[1] = { ...report.peers[0]! };
  expect(networkReportSucceeded(report, ["one", "two"])).toBe(false);
});
