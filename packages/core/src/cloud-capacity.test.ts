import { describe, expect, it } from "vitest";
import { cloudAllocationShortfalls, type CloudCapacityPool } from "./cloud-capacity";

const pool: CloudCapacityPool = {
  cpuCores: { used: 4, max: 4 },
  memoryMb: { used: 4096, max: 8192 },
  diskMb: { used: 16384, max: 32768 },
  workspaces: { used: 2, max: 8 },
};
const micro = { cpuCores: 0.25, memoryMb: 1024, diskMb: 8192 };

describe("shared Cloud capacity", () => {
  it("explains why an additional Micro cannot fit a fully allocated CPU pool", () => {
    expect(cloudAllocationShortfalls(pool, micro)).toEqual([
      { dimension: "cpuCores", used: 4, max: 4, additional: 0.25, missing: 0.25 },
    ]);
  });
  it("allows a redeploy of an existing allocation in a full pool", () => {
    expect(cloudAllocationShortfalls(pool, micro, micro)).toEqual([]);
  });
  it("checks the growth of an existing workspace, without counting a second workspace", () => {
    expect(
      cloudAllocationShortfalls(
        { ...pool, workspaces: { used: 8, max: 8 } },
        { ...micro, cpuCores: 0.5 },
        micro,
      ),
    ).toEqual([{ dimension: "cpuCores", used: 4, max: 4, additional: 0.25, missing: 0.25 }]);
  });
  it("permits reductions when a saved subscription is already over its limit", () => {
    expect(
      cloudAllocationShortfalls({ ...pool, cpuCores: { used: 5, max: 4 } }, micro, {
        ...micro,
        cpuCores: 2,
      }),
    ).toEqual([]);
  });
  it("shows independent CPU, memory, disk and workspace shortages", () => {
    const full = structuredClone(pool);
    for (const meter of Object.values(full)) meter.used = meter.max ?? meter.used;
    expect(cloudAllocationShortfalls(full, micro).map((s) => s.dimension)).toEqual([
      "cpuCores",
      "memoryMb",
      "diskMb",
      "workspaces",
    ]);
  });
  it("does not use memory savings to conceal a CPU shortage", () => {
    expect(
      cloudAllocationShortfalls(pool, { ...micro, cpuCores: 1 }, { ...micro, memoryMb: 2048 })[0]
        ?.missing,
    ).toBe(0.75);
  });
});
