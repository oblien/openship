import { describe, expect, it } from "vitest";
import { secureCookiePreference } from "../src/engine/lib/auth-cookie-policy";

describe("secureCookiePreference", () => {
  it("requires Secure cookies for a public HTTPS instance", () => {
    expect(secureCookiePreference("https://ship.example.com")).toBe(true);
  });

  it("retains HTTP compatibility for local and LAN setup", () => {
    expect(secureCookiePreference("http://openship.lan:3001")).toBe(false);
  });

  it("leaves Better Auth's default untouched when no public URL is declared", () => {
    expect(secureCookiePreference(undefined)).toBeUndefined();
    expect(secureCookiePreference("  ")).toBeUndefined();
  });
});
