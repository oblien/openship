import { describe, expect, it } from "vitest";

import { isValidEmail } from "./utils";

describe("isValidEmail", () => {
  it("rejects the trailing-punctuation typo both old rules let through", () => {
    // The regression: the wizard checked only for an `@`, and the headless rule
    // (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) accepted this too because `,` is neither
    // whitespace nor `@` — so a typo became an admin account nobody could reach.
    expect(isValidEmail("test@gmail.co,")).toBe(false);
    expect(isValidEmail("test@gmail.com.")).toBe(false);
    expect(isValidEmail("test@gmail,com")).toBe(false);
  });

  it("accepts ordinary addresses", () => {
    for (const ok of [
      "test@gmail.com",
      "a@b.co",
      "first.last+tag@sub.domain.example.io",
      "user_name%x@example-host.com",
    ]) {
      expect(isValidEmail(ok), ok).toBe(true);
    }
  });

  it("requires a local part, an @, a dotted domain and a 2+ letter TLD", () => {
    for (const bad of ["", "no-at", "@example.com", "user@", "user@host", "user@host.c", "user@.com"]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });

  it("rejects whitespace and multiple @", () => {
    for (const bad of ["a b@example.com", "a@ex ample.com", " ", "a@@example.com", "a@b@example.com"]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });

  it("trims surrounding whitespace before judging", () => {
    expect(isValidEmail("  test@gmail.com  ")).toBe(true);
  });

  it("caps the length (254) so a pathological value can't reach the API", () => {
    expect(isValidEmail(`${"a".repeat(250)}@example.com`)).toBe(false);
  });

  it("tolerates a null/undefined value without throwing", () => {
    expect(isValidEmail(undefined as unknown as string)).toBe(false);
    expect(isValidEmail(null as unknown as string)).toBe(false);
  });
});
