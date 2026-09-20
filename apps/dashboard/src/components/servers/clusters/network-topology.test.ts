import { describe, expect, it } from "vitest";
import { setNetworkConnection, type ClusterNetworkReport } from "@repo/core";
import { networkLinks, type NetworkTopologyMember } from "./network-topology";

const members: NetworkTopologyMember[] = ["a", "b", "c"].map((serverId, i) => ({
  serverId,
  name: serverId,
  privateIp: `10.0.0.${i + 1}`,
  providerId: "custom",
}));
const report = (): ClusterNetworkReport => ({
  stage: "complete",
  hosts: [],
  peers: [
    {
      sourceServerId: "a",
      targetServerId: "b",
      tcp: true,
      udp: true,
      mtu: true,
      latencyMs: 2,
      latencyKind: "rtt",
      message: null,
    },
    {
      sourceServerId: "b",
      targetServerId: "a",
      tcp: true,
      udp: true,
      mtu: true,
      latencyMs: 4,
      latencyKind: "rtt",
      message: null,
    },
  ],
});
describe("cluster network topology measurements", () => {
  it("tracks one-way access, expected denial, and removed pairs independently from transport", () => {
    const access = setNetworkConnection(
      { version: 1, rules: [] },
      ["a", "b", "c"],
      "a",
      "b",
      "forward",
    );
    const value = report();
    Object.assign(value.peers[1]!, {
      tcp: false,
      udp: false,
      mtu: false,
      reachable: false,
      expectedAccess: "deny",
      policyPassed: true,
      latencyMs: null,
    });
    const links = networkLinks(members, value, access);
    expect(links[0]).toMatchObject({
      accessMode: "forward",
      connected: true,
      state: "passed",
      latencyMs: 2,
    });
    expect(links[1]).toMatchObject({ accessMode: "blocked", connected: false });
    expect(links[0]!.directions.map((direction) => direction.allowed)).toEqual([true, false]);
    value.peers[1]!.reachable = true;
    value.peers[1]!.policyPassed = false;
    expect(networkLinks(members, value, access)[0]!.state).toBe("failed");
  });
  it("groups a mesh into one link per pair with independent directional measurements", () => {
    const links = networkLinks(members, report());
    expect(links).toHaveLength(3);
    expect(links[0]).toMatchObject({ state: "passed", latencyMs: 4 });
    expect(links[0]!.directions.map((direction) => direction.check?.latencyMs)).toEqual([2, 4]);
    expect(links[1]!.state).toBe("unchecked");
  });
  it("does not claim bidirectional reachability or RTT from an incomplete or older check", () => {
    const value = report();
    value.peers.pop();
    expect(networkLinks(members, value)[0]).toMatchObject({ state: "unchecked", latencyMs: null });
    const legacy = report();
    delete legacy.peers[0]!.latencyKind;
    expect(networkLinks(members, legacy)[0]!.latencyMs).toBeNull();
  });
  it("shows handshake failures without inventing TCP, UDP, latency or speed results", () => {
    const value: ClusterNetworkReport = {
      stage: "handshakes",
      hosts: [],
      peers: [],
      handshakes: [
        {
          sourceServerId: "a",
          targetServerId: "c",
          endpoint: "192.0.2.3",
          port: 51820,
          ok: false,
          lastHandshakeAt: null,
        },
      ],
    };
    const link = networkLinks(members, value)[1]!;
    expect(link.state).toBe("failed");
    expect(link.directions[0]).toMatchObject({
      check: undefined,
      speed: undefined,
      handshake: { endpoint: "192.0.2.3", ok: false },
    });
    expect(link.latencyMs).toBeNull();
  });
});
