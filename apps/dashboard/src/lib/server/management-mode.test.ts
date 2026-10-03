import { describe, expect, it } from "vitest";
import { deployableServers, isManagedServer } from "./management-mode";

describe("server management mode", () => {
  it("keeps legacy and managed rows deployable", () => {
    expect(isManagedServer({})).toBe(true);
    expect(isManagedServer({ managementMode: "managed" })).toBe(true);
  });

  it("removes observe-only rows before target selection", () => {
    const rows = [
      { id: "legacy" },
      { id: "managed", managementMode: "managed" as const },
      { id: "observer", managementMode: "observe_only" as const },
    ];
    expect(deployableServers(rows).map((row) => row.id)).toEqual(["legacy", "managed"]);
  });
});
