import { describe, expect, it } from "vitest";

import { formatBytes, slugify } from "../src/utils";

describe("formatBytes", () => {
  it("formats common magnitudes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
  });

  it("never emits 'undefined' for magnitudes beyond TB", () => {
    expect(formatBytes(1024 ** 5)).not.toContain("undefined");
    expect(formatBytes(1024 ** 6)).not.toContain("undefined");
  });

  it("never emits 'NaN'/'undefined' for non-positive input", () => {
    expect(formatBytes(-5)).not.toMatch(/NaN|undefined/);
    expect(formatBytes(0.5)).not.toMatch(/NaN|undefined/);
  });
});

describe("slugify", () => {
  it("does not end in a hyphen after truncation at a word boundary", () => {
    const slug = slugify("a".repeat(99) + " b");
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(100);
  });

  it("still slugifies normal input", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("  Trim Me  ")).toBe("trim-me");
  });
});
