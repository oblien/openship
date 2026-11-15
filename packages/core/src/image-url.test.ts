import { describe, expect, it } from "vitest";
import { isImageUrl, MAX_IMAGE_URL_LENGTH } from "./image-url";

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
});
