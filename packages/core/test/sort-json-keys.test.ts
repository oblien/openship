import { describe, expect, it } from "vitest";
import { sortJsonKeys } from "../src/utils";

describe("sortJsonKeys", () => {
  it("gives reordered nested maps the same serialized value", () => {
    const left = { z: [{ b: 2, a: 1 }], a: { y: null, x: false } };
    const right = { a: { x: false, y: null }, z: [{ a: 1, b: 2 }] };
    expect(JSON.stringify(sortJsonKeys(left))).toBe(JSON.stringify(sortJsonKeys(right)));
  });

  it("preserves meaningful array order and scalar values", () => {
    const source = { ports: [4000, 3000], argv: ["server", "--debug"], empty: "", enabled: false };
    expect(sortJsonKeys(source)).toEqual(source);
    expect(JSON.stringify(sortJsonKeys(source))).not.toBe(
      JSON.stringify(sortJsonKeys({ ...source, ports: [3000, 4000] })),
    );
  });

  it("does not mutate configuration or use locale-dependent key order", () => {
    const source = { é: 1, z: { B: 2, A: 1 }, A: 0 };
    const before = JSON.stringify(source);
    expect(JSON.stringify(sortJsonKeys(source))).toBe('{"A":0,"z":{"A":1,"B":2},"é":1}');
    expect(JSON.stringify(source)).toBe(before);
  });

  it("preserves JSON keys that also name prototype properties", () => {
    const source = JSON.parse('{"constructor":"value","__proto__":{"z":1,"a":2}}');
    expect(JSON.stringify(sortJsonKeys(source))).toBe(
      '{"__proto__":{"a":2,"z":1},"constructor":"value"}',
    );
  });
});
