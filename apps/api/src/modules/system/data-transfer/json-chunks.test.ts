import { describe, expect, it } from "vitest";

import { jsonByteChunks } from "./json-chunks";

describe("jsonByteChunks", () => {
  it("matches JSON.stringify while keeping every emitted chunk bounded", () => {
    const value = {
      date: new Date("2026-01-02T03:04:05.000Z"),
      rows: [
        { id: "one", log: "🙂\\n".repeat(80) },
        { id: "two", omitted: undefined, finite: Number.NaN },
        undefined,
      ],
    };
    const chunks = [...jsonByteChunks(value, 97)];

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.byteLength <= 97)).toBe(true);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(JSON.stringify(value));
  });

  it("does not allocate one fragment for a large string", () => {
    const chunks = [...jsonByteChunks({ log: "x".repeat(1_000_000) }, 64_000)];
    expect(chunks.length).toBeGreaterThan(10);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({
      log: "x".repeat(1_000_000),
    });
  });

  it("matches JSON.stringify toJSON and omission semantics", () => {
    const selfReturning = {
      value: 42,
      toJSON() {
        return this;
      },
    };
    const value = {
      selfReturning,
      omitted: { toJSON: () => undefined },
      array: [{ toJSON: () => undefined }],
    };
    expect(Buffer.concat([...jsonByteChunks(value, 7)]).toString("utf8")).toBe(
      JSON.stringify(value),
    );
    expect([...jsonByteChunks(undefined, 7)]).toEqual([]);
  });
});
