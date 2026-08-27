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
});
