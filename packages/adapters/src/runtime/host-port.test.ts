import { describe, it, expect } from "vitest";
import { pickHostPort } from "./host-port";

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
    expect(() => pickHostPort(new Set([30000, 30001]), { rangeStart: 30000, rangeEnd: 30001 })).toThrow(
      /No free host port/,
    );
  });
});
