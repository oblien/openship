import { describe, expect, it } from "vitest";

import { parseDotenv } from "./dotenv";

describe("parseDotenv", () => {
  it("skips blank lines and # comment lines", () => {
    const content = ["", "# a comment", "API_KEY=fake-not-a-real-key", "   ", "# another"].join(
      "\n",
    );
    expect(parseDotenv(content)).toEqual([{ key: "API_KEY", value: "fake-not-a-real-key" }]);
  });

  it("skips lines without an =", () => {
    expect(parseDotenv("just some text\nTOKEN=dummy-value")).toEqual([
      { key: "TOKEN", value: "dummy-value" },
    ]);
  });

  it("skips lines whose key is not a valid identifier", () => {
    // Leading digit and an embedded hyphen both fail /^[A-Za-z_][A-Za-z0-9_]*$/.
    expect(parseDotenv("1FOO=x\nFOO-BAR=x\nGOOD_KEY=dummy-value")).toEqual([
      { key: "GOOD_KEY", value: "dummy-value" },
    ]);
  });

  it("splits on the first = only", () => {
    expect(parseDotenv("A=b=c")).toEqual([{ key: "A", value: "b=c" }]);
  });

  it("unwraps double and single quoted values", () => {
    expect(parseDotenv('A="fake-token"')).toEqual([{ key: "A", value: "fake-token" }]);
    expect(parseDotenv("B='dummy-value'")).toEqual([{ key: "B", value: "dummy-value" }]);
  });

  it("takes the rest of the line when a double quote is never closed", () => {
    expect(parseDotenv('A="hello')).toEqual([{ key: "A", value: "hello" }]);
  });

  it("discards anything after the closing quote", () => {
    expect(parseDotenv('A="x"junk')).toEqual([{ key: "A", value: "x" }]);
  });

  it("strips an inline comment from an unquoted value only when whitespace precedes #", () => {
    expect(parseDotenv("A=bar # note")).toEqual([{ key: "A", value: "bar" }]);
    // No whitespace before the #, so it is treated as part of the value.
    expect(parseDotenv("A=bar#note")).toEqual([{ key: "A", value: "bar#note" }]);
  });

  it("preserves a # inside a quoted value", () => {
    expect(parseDotenv('A="bar # baz"')).toEqual([{ key: "A", value: "bar # baz" }]);
  });

  it("yields an empty string for a key with no value", () => {
    expect(parseDotenv("A=")).toEqual([{ key: "A", value: "" }]);
  });

  it("handles CRLF line endings", () => {
    expect(parseDotenv("A=fake-value\r\nB=dummy-value\r\n")).toEqual([
      { key: "A", value: "fake-value" },
      { key: "B", value: "dummy-value" },
    ]);
  });
});
