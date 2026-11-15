import { describe, expect, it } from "vitest";
import { isImageUrl, MAX_IMAGE_URL_LENGTH, projectIconUrl } from "./image-url";

describe("display image URLs", () => {
  it.each([
    "https://cdn.example.test/avatar.png?v=2",
    "http://images.example.test/icon.svg",
    "https://example.test/a%20b.png",
  ])("accepts %s", (url) => expect(isImageUrl(url)).toBe(true));
  it.each([
    null,
    123,
    "",
    "/icon.png",
    "//example.test/icon",
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "file:///etc/passwd",
    "blob:https://example.test/id",
    "https://user:password@example.test/a.png",
    "https://example.test/\nimage.png",
    " https://example.test/image.png",
    `https://example.test/${"a".repeat(MAX_IMAGE_URL_LENGTH)}`,
  ])("refuses unsafe or malformed input %j", (url) => expect(isImageUrl(url)).toBe(false));
  it("uses an explicit project icon before the discovered cache and restores the cache when cleared", () => {
    const project = {
      iconUrl: "https://images.example.test/custom.png",
      favicon: "https://app.example.test/favicon.ico",
    };
    expect(projectIconUrl(project)).toBe(project.iconUrl);
    expect(projectIconUrl({ ...project, iconUrl: null })).toBe(project.favicon);
    expect(projectIconUrl(null)).toBeNull();
  });
});
