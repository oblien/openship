import { describe, expect, it } from "vitest";
import {
  allocateClusterRuntimeRanges,
  assertClusterRuntimeRanges,
  assertClusterRuntimeNetwork,
  clusterRuntimeConnections,
} from "./cluster-runtime";
import { fullNetworkAccess } from "./network-access";

const hosts = ["a", "b", "c"].map((serverId, index) => ({
  serverId,
  privateIp: `10.20.0.${index + 1}`,
  role: index === 2 ? ("agent" as const) : ("server" as const),
}));
describe("cluster runtime networking", () => {
  it("allocates complete node and service ranges away from host, Docker, route and DNS ranges", () => {
    expect(allocateClusterRuntimeRanges(["10.42.0.0/16", "10.43.8.0/24", "10.44.0.53/32"])).toEqual(
      { podCidr: "10.45.0.0/16", serviceCidr: "10.46.0.0/16" },
    );
    expect(allocateClusterRuntimeRanges(["10.0.0.0/8", "172.17.0.0/16"])).toEqual({
      podCidr: "172.16.0.0/16",
      serviceCidr: "172.18.0.0/16",
    });
    expect(() =>
      allocateClusterRuntimeRanges(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]),
    ).toThrow("No free");
  });
  it("rechecks pinned ranges against changed host routes on retry", () => {
    expect(() =>
      assertClusterRuntimeRanges("10.42.0.0/16", "10.43.0.0/16", ["10.20.0.0/24"]),
    ).not.toThrow();
    expect(() =>
      assertClusterRuntimeRanges("10.42.0.0/16", "10.43.0.0/16", ["10.43.0.53/32"]),
    ).toThrow("conflict");
    expect(() => assertClusterRuntimeRanges("10.42.0.0/24", "10.43.0.0/16", [])).toThrow("invalid");
  });
  it("requires all cluster members to allow private connections in both directions", () => {
    expect(() => assertClusterRuntimeNetwork(hosts)).not.toThrow();
    expect(() =>
      assertClusterRuntimeNetwork(hosts, fullNetworkAccess(["a", "b", "c"])),
    ).not.toThrow();
    const policy = fullNetworkAccess(["a", "b", "c"]);
    policy.rules.pop();
    expect(() => assertClusterRuntimeNetwork(hosts, policy)).toThrow("both directions");
    expect(() => assertClusterRuntimeNetwork([{ serverId: "a", privateIp: "8.8.8.8" }])).toThrow(
      "private IPv4",
    );
  });
  it("restricts API and database transport rules to the servers that actually need them", () => {
    const rules = clusterRuntimeConnections(hosts);
    expect(rules.filter((rule) => rule.port === 8472)).toHaveLength(6);
    expect(rules.filter((rule) => rule.port === 6443)).toHaveLength(4);
    expect(rules.filter((rule) => rule.port === 2379)).toHaveLength(2);
    expect(
      rules
        .filter((rule) => rule.port === 2379)
        .every((rule) => rule.sourceServerId !== "c" && rule.targetServerId !== "c"),
    ).toBe(true);
    expect(
      rules.every(
        (rule) =>
          rule.sourceIp.startsWith("10.") &&
          rule.targetIp.startsWith("10.") &&
          rule.sourceServerId !== rule.targetServerId,
      ),
    ).toBe(true);
  });
});
