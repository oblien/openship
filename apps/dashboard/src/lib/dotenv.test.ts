import { describe, expect, it } from "vitest";

import { parseDotenv, serializeDotenv } from "./dotenv";

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

  it("handles CRLF line endings and a UTF-8 BOM", () => {
    expect(parseDotenv("\uFEFFA=fake-value\r\nB=dummy-value\r\n")).toEqual([
      { key: "A", value: "fake-value" },
      { key: "B", value: "dummy-value" },
    ]);
  });
});

describe(".env export", () => {
  it("preserves values when an exported file is imported again", () => {
    const rows = [
      { key: "PORT", value: "3000" },
      { key: "EMPTY", value: "" },
      { key: "SPACES", value: "  keep these  " },
      { key: "COMMENT", value: "hello # world" },
      { key: "QUOTES", value: `both 'single' and "double" quotes` },
      { key: "MULTILINE", value: "first\nSECOND=still part of the value\nlast\r\n" },
      { key: "BACKSLASH", value: "C:\\new\\file" },
      { key: "ESCAPES", value: "it's a literal \\n and a real\nnewline" },
      { key: "DOLLAR", value: "${KEEP_LITERAL}" },
      { key: "UNICODE", value: "مرحبا 🌍" },
    ];
    const content = serializeDotenv(rows);
    expect(content).toContain("PORT=3000\nEMPTY=\n");
    expect(parseDotenv(content)).toEqual(rows);
  });

  it("rejects names that would be lost or become additional assignments on import", () => {
    expect(() => serializeDotenv([{ key: "BAD\nINJECTED", value: "x" }])).toThrow();
    expect(() =>
      serializeDotenv([
        { key: "PORT", value: "3000" },
        { key: " PORT ", value: "4000" },
      ]),
    ).toThrow();
  });
});
