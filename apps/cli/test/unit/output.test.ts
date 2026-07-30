import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { err, info, isJsonMode, ok, printJson, printTable, setJsonMode } from "../../src/lib/output";
import { captureStdio, type Captured } from "../helpers/harness";

let cap: Captured;

beforeEach(() => {
  setJsonMode(false);
  cap = captureStdio();
});
afterEach(() => {
  cap.restore();
  setJsonMode(false);
});

describe("json mode flag", () => {
  it("toggles", () => {
    setJsonMode(true);
    expect(isJsonMode()).toBe(true);
    setJsonMode(false);
    expect(isJsonMode()).toBe(false);
  });
});

describe("printJson", () => {
  it("writes pretty JSON with a trailing newline to stdout", () => {
    printJson({ a: 1, b: "x" });
    expect(cap.out()).toBe('{\n  "a": 1,\n  "b": "x"\n}\n');
    expect(cap.err()).toBe("");
  });
});

describe("printTable", () => {
  it("aligns columns and bolds the header on stdout (text mode)", () => {
    printTable(
      [
        { id: "1", name: "alpha" },
        { id: "22", name: "b" },
      ],
      ["id", "name"],
    );
    const lines = cap.out().split("\n").filter(Boolean);
    expect(lines[0]).toBe("  id  name");
    // "1"/"22" pad to width 2, so "1 " then two-space gap then value.
    expect(lines[1]).toBe("  1   alpha");
    expect(lines[2]).toBe("  22  b");
  });

  it("defaults columns to the union of row keys", () => {
    printTable([{ a: "1" }, { b: "2" }]);
    expect(cap.out()).toContain("a");
    expect(cap.out()).toContain("b");
  });

  it("prints a placeholder to stderr (not stdout) when there are no rows", () => {
    printTable([]);
    expect(cap.out()).toBe("");
    expect(cap.err()).toContain("(no rows)");
  });

  it("emits JSON to stdout when json mode is on", () => {
    setJsonMode(true);
    printTable([{ id: "1" }], ["id"]);
    expect(JSON.parse(cap.out())).toEqual([{ id: "1" }]);
  });
});

describe("message helpers route to the right stream", () => {
  it("ok/info go to stderr in text mode and are silenced in json mode", () => {
    ok("done");
    info("fyi");
    expect(cap.err()).toContain("done");
    expect(cap.err()).toContain("fyi");
    expect(cap.out()).toBe("");
  });

  it("err always writes to stderr, even in json mode", () => {
    setJsonMode(true);
    err("boom");
    ok("silenced");
    expect(cap.err()).toContain("boom");
    expect(cap.err()).not.toContain("silenced");
  });
});
