import { describe, it, expect } from "vitest";
import { allocateHostPort, pickHostPort } from "./host-port";
import type { CommandExecutor } from "../types";

describe("pickHostPort", () => {
  it("reuses the preferred (persisted) port when it's free", () => {
    expect(pickHostPort(new Set(), { preferred: 20500 })).toBe(20500);
  });

  it("reuses a preferred port even outside the default range (persisted earlier)", () => {
    expect(pickHostPort(new Set(), { preferred: 41000 })).toBe(41000);
  });

  it("skips the preferred port when occupied and falls to the range", () => {
    expect(pickHostPort(new Set([20500]), { preferred: 20500 })).toBe(20000);
  });

  it("reuses an occupied preferred port only when the caller proved ownership", () => {
    expect(
      pickHostPort(new Set([20500]), {
        preferred: 20500,
        reuseOccupiedPreferred: true,
      }),
    ).toBe(20500);
  });

  it("never lets proven ownership override another owner's avoid claim", () => {
    expect(
      pickHostPort(new Set([20500]), {
        preferred: 20500,
        reuseOccupiedPreferred: true,
        avoid: [20500],
      }),
    ).toBe(20000);
  });

  it("skips occupied + avoided ports", () => {
    const occupied = new Set([20000, 20001]);
    expect(pickHostPort(occupied, { avoid: [20002, 20003] })).toBe(20004);
  });

  it("never hands out a port pinned to another project (avoid)", () => {
    expect(pickHostPort(new Set(), { avoid: [20000] })).toBe(20001);
  });

  it("scans within a custom range", () => {
    expect(pickHostPort(new Set([30000]), { rangeStart: 30000, rangeEnd: 30002 })).toBe(30001);
  });

  it("does not reuse a preferred port inside the target's ephemeral range", () => {
    // A publish pinned there can lose its port to an outbound connection while the
    // container is stopped; the restart then fails with "address already in use".
    const ephemeralRange = { start: 32768, end: 60999 };
    expect(pickHostPort(new Set(), { preferred: 32769, ephemeralRange })).toBe(20000);
    expect(pickHostPort(new Set(), { preferred: 25000, ephemeralRange })).toBe(25000);
  });

  it("moves an ephemeral pin even when the current workload owns it", () => {
    expect(
      pickHostPort(new Set([32769]), {
        preferred: 32769,
        reuseOccupiedPreferred: true,
        ephemeralRange: { start: 32768, end: 60999 },
      }),
    ).toBe(20000);
  });

  it.each([
    { ephemeralRange: { start: 19999, end: 20002 }, occupied: [], avoid: [], expected: 20003 },
    {
      ephemeralRange: { start: 20002, end: 20004 },
      occupied: [20000],
      avoid: [20001],
      expected: 20005,
    },
    {
      ephemeralRange: { start: 20004, end: 20008 },
      occupied: [20000, 20001],
      avoid: [20002],
      expected: 20003,
    },
    { ephemeralRange: { start: 20000, end: 20000 }, occupied: [], avoid: [], expected: 20001 },
  ])("excludes $ephemeralRange while honoring listeners and claims", (test) => {
    expect(
      pickHostPort(new Set(test.occupied), {
        rangeStart: 20000,
        rangeEnd: 20006,
        ephemeralRange: test.ephemeralRange,
        avoid: test.avoid,
      }),
    ).toBe(test.expected);
  });

  it("refuses a fully ephemeral allocation range instead of pinning an unsafe port", () => {
    expect(() =>
      pickHostPort(new Set(), {
        preferred: 20500,
        reuseOccupiedPreferred: true,
        ephemeralRange: { start: 20000, end: 60999 },
      }),
    ).toThrow(/No free host port/);
  });

  it("refuses an ephemeral fallback when every safe candidate is occupied or claimed", () => {
    expect(() =>
      pickHostPort(new Set([20000]), {
        rangeStart: 20000,
        rangeEnd: 20004,
        avoid: [20004],
        ephemeralRange: { start: 20001, end: 20003 },
      }),
    ).toThrow(/No free host port/);
  });

  it("keeps a safe preferred port when the scan range is entirely ephemeral", () => {
    expect(
      pickHostPort(new Set([19000]), {
        preferred: 19000,
        reuseOccupiedPreferred: true,
        ephemeralRange: { start: 20000, end: 60999 },
      }),
    ).toBe(19000);
  });

  it("throws when the range is exhausted", () => {
    expect(() =>
      pickHostPort(new Set([30000, 30001]), { rangeStart: 30000, rangeEnd: 30001 }),
    ).toThrow(/No free host port/);
  });
});

const fakeExecutor = (exec: (cmd: string) => Promise<string>): CommandExecutor =>
  ({ exec }) as unknown as CommandExecutor;

describe("allocateHostPort", () => {
  it("reports scanned:false when the target could not be read at all", async () => {
    // `scanPorts` never throws, so an executor that reaches nothing looks exactly
    // like a host with no listeners. The flag is the only thing that tells them
    // apart, and it has to survive out to the caller (#490).
    const unreachable = fakeExecutor(async () => {
      throw new Error("Host control is disabled on this instance.");
    });
    const allocation = await allocateHostPort(unreachable, { avoid: [20000] });
    expect(allocation.scanned).toBe(false);
    // Still hands out a usable pick: refusing here would break every loopback-port
    // deploy on a box whose host channel is blocked — the bug's own shape.
    expect(allocation.port).toBe(20001);
  });

  it("reports scanned:true and skips a live listener", async () => {
    const listening = fakeExecutor(async (cmd) =>
      cmd.startsWith("ss ")
        ? `tcp LISTEN 0 511 127.0.0.1:20000 0.0.0.0:* users:(("x",pid=1,fd=6))`
        : "",
    );
    const allocation = await allocateHostPort(listening);
    expect(allocation.scanned).toBe(true);
    expect(allocation.port).toBe(20001);
  });

  it("reads the target's ephemeral range rather than assuming one", async () => {
    const narrowed = fakeExecutor(async (cmd) =>
      cmd.includes("ip_local_port_range") ? "40000\t50000\n" : "",
    );
    expect((await allocateHostPort(narrowed, { preferred: 32769 })).port).toBe(32769);
    expect((await allocateHostPort(narrowed, { preferred: 41000 })).port).toBe(20000);
  });

  it("allocates a safe replacement when the target's ephemeral range overlaps the pool", async () => {
    const target = fakeExecutor(async (cmd) =>
      cmd.includes("ip_local_port_range") ? "20000\t25000\n" : "##tcp\n",
    );
    const allocation = await allocateHostPort(target, {
      preferred: 20500,
      reuseOccupiedPreferred: true,
      avoid: [25001],
    });
    expect(allocation).toEqual({ port: 25002, scanned: true });
  });

  it("assumes Linux's default ephemeral range when the target can't say", async () => {
    const unreachable = fakeExecutor(async () => {
      throw new Error("Host control is disabled on this instance.");
    });
    expect((await allocateHostPort(unreachable, { preferred: 32769 })).port).toBe(20000);
    expect((await allocateHostPort(unreachable, { preferred: 25000 })).port).toBe(25000);
  });
});
