import { describe, expect, it } from "vitest";
import {
  fullNetworkAccess,
  networkAccessAllowed,
  networkConnectionMode,
  networkTransportPeers,
  normalizeNetworkAccess,
  retainNetworkAccess,
  setNetworkConnection,
} from "./network-access";

describe("managed network connection policy", () => {
  const ids = ["hub", "db", "worker"];
  it("preserves omitted full meshes and distinguishes an explicitly isolated network", () => {
    expect(networkConnectionMode(undefined, "hub", "db")).toBe("both");
    expect(networkConnectionMode({ version: 1, rules: [] }, "hub", "db")).toBe("blocked");
    expect(networkAccessAllowed(undefined, "hub", "hub")).toBe(false);
  });
  it("supports a hub initiating connections without connecting the spokes to each other", () => {
    let policy = setNetworkConnection({ version: 1, rules: [] }, ids, "hub", "db", "forward");
    policy = setNetworkConnection(policy, ids, "hub", "worker", "forward");
    expect(networkConnectionMode(policy, "hub", "db")).toBe("forward");
    expect(networkAccessAllowed(policy, "db", "hub")).toBe(false);
    expect(
      networkTransportPeers(
        ids.map((serverId) => ({ serverId })),
        "db",
        policy,
      ),
    ).toEqual([{ serverId: "hub" }]);
    expect(
      networkTransportPeers(
        ids.map((serverId) => ({ serverId })),
        "hub",
        policy,
      ),
    ).toHaveLength(2);
  });
  it("removes and restores just the selected pair, with stable normalized request ordering", () => {
    const removed = setNetworkConnection(undefined, ids, "hub", "db", "blocked");
    expect(removed.rules).toHaveLength(4);
    expect(networkConnectionMode(removed, "hub", "worker")).toBe("both");
    expect(setNetworkConnection(removed, ids, "db", "hub", "both")).toEqual(fullNetworkAccess(ids));
    expect(
      normalizeNetworkAccess({ version: 1, rules: [...removed.rules].reverse() }, ids),
    ).toEqual(removed);
    expect(retainNetworkAccess(removed, ["hub", "db"])?.rules).toEqual([]);
  });
  it.each([
    { version: 2, rules: [] },
    { version: 1, rules: [{ sourceServerId: "hub", targetServerId: "foreign" }] },
    { version: 1, rules: [{ sourceServerId: "hub", targetServerId: "hub" }] },
    { version: 1, rules: Array(2).fill({ sourceServerId: "hub", targetServerId: "db" }) },
  ])("rejects invalid or ambiguous policy input", (policy) => {
    expect(() => normalizeNetworkAccess(policy as never, ids)).toThrow();
  });
});
