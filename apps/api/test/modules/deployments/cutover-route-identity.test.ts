import { describe, expect, it } from "vitest";
import { hasRestorableServicePorts } from "../../../../../packages/platform/src/engine/modules/deployments/compose/cutover-route-identity";

const previous = {
  port: 3000,
  composeServices: [
    {
      name: "api",
      enabled: true,
      exposedPort: "3000",
      ports: ["3000", "127.0.0.1:20001:4000"],
      publicEndpoints: [{ port: 3000 }, { port: 5000 }],
    },
  ],
};

describe("service overlap routing recovery admission", () => {
  it("accepts unchanged ports through the existing primary, binding and endpoint parsers", () => {
    expect(hasRestorableServicePorts(previous, "api", [3000, 4000, 5000])).toBe(
      true,
    );
  });
  it("rejects a new primary or a secondary project/composite upstream port", () => {
    expect(hasRestorableServicePorts(previous, "api", [9090])).toBe(false);
    expect(hasRestorableServicePorts(previous, "api", [3000, 9090])).toBe(
      false,
    );
  });
  it("uses the previous project's frozen fallback instead of today's port", () => {
    const inherited = { port: 3000, composeServices: [{ name: "api" }] };
    expect(hasRestorableServicePorts(inherited, "api", [3000])).toBe(true);
    expect(hasRestorableServicePorts(inherited, "api", [4000])).toBe(false);
  });
  it.each([
    null,
    {},
    { port: 3000 },
    { composeServices: [] },
    { composeServices: [{ name: "other", exposedPort: "3000" }] },
    { composeServices: [{ name: "api", exposedPort: "3000", enabled: false }] },
    { composeServices: [{ name: "api" }, { name: "api" }] },
    { composeServices: [{ name: "api", ports: [3000] }] },
  ])(
    "rejects unknown or malformed predecessor configuration %#",
    (snapshot) => {
      expect(hasRestorableServicePorts(snapshot, "api", [3000])).toBe(false);
    },
  );
  it("does not mistake a published host port for the container's routing port", () => {
    expect(hasRestorableServicePorts(previous, "api", [20001])).toBe(false);
  });
});
