import { describe, it, expect } from "bun:test";
import { signInSchema } from "../src/lib/schemas";
import { formatFromAddress } from "../src/trpc/routes/mail";

describe("Webmail From display name", () => {
  describe("signInSchema", () => {
    it("accepts name in sign-in input", () => {
      const parsed = signInSchema.parse({
        email: "user@example.com",
        password: "secretpassword",
        name: "Bikram C",
      });
      expect(parsed.name).toBe("Bikram C");
    });

    it("works when name is omitted", () => {
      const parsed = signInSchema.parse({
        email: "user@example.com",
        password: "secretpassword",
      });
      expect(parsed.name).toBeUndefined();
    });
  });

  describe("formatFromAddress", () => {
    it("formats bare email with session display name", () => {
      const from = formatFromAddress(undefined, "user@example.com", "Bikram C");
      expect(from).toBe('"Bikram C" <user@example.com>');
    });

    it("sanitizes special characters in session display name", () => {
      const from = formatFromAddress(undefined, "user@example.com", "Bikram <C>");
      expect(from).toBe('"Bikram C" <user@example.com>');
    });

    it("falls back to bare address when session name is missing or empty", () => {
      expect(formatFromAddress(undefined, "user@example.com", null)).toBe("user@example.com");
      expect(formatFromAddress(undefined, "user@example.com", "")).toBe("user@example.com");
    });

    it("preserves explicitly formatted fromEmail input", () => {
      const from = formatFromAddress(
        '"Custom Name" <custom@example.com>',
        "user@example.com",
        "Bikram C",
      );
      expect(from).toBe('"Custom Name" <custom@example.com>');
    });
  });
});
