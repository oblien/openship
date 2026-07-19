import { describe, expect, it } from "vitest";

import { mergeTrustedOrigin, normalizePublicUrl } from "./public-url";

describe("normalizePublicUrl", () => {
  it("accepts and canonicalizes an HTTP(S) origin", () => {
    expect(normalizePublicUrl("https://openship.example.com/")).toBe(
      "https://openship.example.com",
    );
  });

  it.each([
    "ssh://openship.example.com",
    "https://openship.example.com/path",
    "https://user:secret@openship.example.com",
    "not a url",
  ])("rejects non-origin input %s", (value) => {
    expect(() => normalizePublicUrl(value)).toThrow();
  });
});

describe("mergeTrustedOrigin", () => {
  it("preserves existing origins and de-duplicates the public origin", () => {
    expect(
      mergeTrustedOrigin(
        "https://admin.example.com, https://openship.example.com",
        "https://openship.example.com",
      ),
    ).toBe("https://admin.example.com,https://openship.example.com");
  });
});
