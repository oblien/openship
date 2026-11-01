import { describe, expect, it } from "vitest";
import { dnsTxtValue, quotedDnsTxt } from "@repo/platform/engine/lib/dns-txt";

describe("DNS TXT presentation", () => {
  it.each([
    ['token', 'token'],
    ['"token"', 'token'],
    ['"first" "second"', 'firstsecond'],
    ['"first""second"', 'firstsecond'],
    ['"to\\107en"', 'token'],
    ['"quote\\" and backslash\\\\"', 'quote" and backslash\\'],
    ['"\\195\\169"', 'é'],
    ['""', ''],
    ['"unterminated', '"unterminated'],
    ['"token" unexpected', '"token" unexpected'],
    ['"\\999"', '"\\999"'],
  ])("decodes %s without treating DNS delimiters as token bytes", (input, expected) => {
    expect(dnsTxtValue(input)).toBe(expected);
  });

  it("quotes ownership values exactly once", () => {
    expect(quotedDnsTxt("token")).toBe('"token"');
    expect(quotedDnsTxt('"token"')).toBe('"token"');
    expect(quotedDnsTxt('"to" "ken"')).toBe('"token"');
  });

  it.each(['a "quote" and \\ slash', "line\nbreak\t\u0000", "한글 🦄", ""]) (
    "escapes content without changing its published bytes: %s", (value) => {
      expect(dnsTxtValue(quotedDnsTxt(value))).toBe(value);
    },
  );

  it("splits long content into DNS character strings of at most 255 UTF-8 bytes", () => {
    const value = "한".repeat(200) + "token";
    const formatted = quotedDnsTxt(value);
    expect(formatted).toContain('" "');
    for (const chunk of formatted.split('" "')) {
      expect(Buffer.byteLength(chunk.replace(/^"|"$/g, ""))).toBeLessThanOrEqual(255);
    }
    expect(dnsTxtValue(formatted)).toBe(value);
    expect(quotedDnsTxt(formatted)).toBe(formatted);
  });
});
