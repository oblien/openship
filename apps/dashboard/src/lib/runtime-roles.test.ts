import { describe, expect, it } from "vitest";
import { canConfigureRuntimeRoles } from "./runtime-roles";

describe("canConfigureRuntimeRoles", () => {
  it("offers projects created before runtimeMode was recorded", () => {
    expect(canConfigureRuntimeRoles({ runtimeMode: null, deployTarget: "server" })).toBe(true);
    expect(canConfigureRuntimeRoles({ deployTarget: "local" })).toBe(true);
  });

  it("withholds bare, Cloud and cluster projects", () => {
    expect(canConfigureRuntimeRoles({ runtimeMode: "bare", deployTarget: "server" })).toBe(false);
    expect(canConfigureRuntimeRoles({ runtimeMode: "docker", deployTarget: "cloud" })).toBe(false);
    expect(canConfigureRuntimeRoles({ runtimeMode: "docker", clusterId: "cluster-1" })).toBe(false);
  });
});
