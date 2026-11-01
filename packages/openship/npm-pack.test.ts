import { describe, expect, it } from "bun:test";
import { readPackedArchive } from "./npm-pack";

const expected = { name: "openship", version: "0.8.0" };
const archive = { ...expected, filename: "openship-0.8.0.tgz", size: 100, unpackedSize: 400 };

describe("npm pack reports", () => {
  it.each([[archive], { openship: archive }].map(report => ({ report })))("accepts npm's supported report shapes (%j)", ({ report }) => {
    expect(readPackedArchive(JSON.stringify(report), expected)).toEqual(archive);
  });

  it.each([
    [], {}, null, [archive, archive], { openship: archive, unexpected: archive },
    { error: { code: "E404" } },
    [{ ...archive, name: "another-package" }],
    [{ ...archive, version: "0.7.0" }],
    [{ ...archive, filename: "../outside.tgz" }],
    [{ ...archive, filename: "/outside.tgz" }],
    [{ ...archive, filename: "openship.tar" }],
    [{ ...archive, size: 0 }],
    [{ ...archive, size: "100" }],
    [{ ...archive, unpackedSize: -1 }],
  ].map(report => ({ report })))("rejects missing, ambiguous or mismatched packages (%j)", ({ report }) => {
    expect(() => readPackedArchive(JSON.stringify(report), expected)).toThrow();
  });
});
