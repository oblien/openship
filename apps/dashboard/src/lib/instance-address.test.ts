import { describe, expect, it } from "vitest";
import { parseInstanceAddress } from "./instance-address";

describe("Desktop instance addresses", () => {
  it.each(["https://ops.example.test", "ops.example.test", "  ops.example.test/  "])(
    "normalizes %s to an HTTPS login",
    (value) => {
      expect(parseInstanceAddress(value)).toEqual({
        origin: "https://ops.example.test",
        nextPath: "/login",
      });
    },
  );
  it.each([
    "",
    "/login",
    "//ops.example.test",
    "ops.example.test\\evil",
    "ops.example.test /login",
  ])("rejects an ambiguous address: %s", (value) => {
    expect(parseInstanceAddress(value)).toBeNull();
  });
  it.each([
    "http://ops.example.test",
    "ftp://ops.example.test",
    "https://user:password@ops.example.test",
    "https://ops.example.test?redirect=https://other.test",
    "https://ops.example.test#token",
    "https://ops.example.test/projects",
    "https://ops.example.test/accept-invite/inv_1/extra",
  ])("rejects unsafe protocols or paths: %s", (value) => {
    expect(() => parseInstanceAddress(value)).toThrow();
  });
  it.each(["", "/api/proxy"])("accepts an invitation at the known %s mount only", (mount) => {
    expect(
      parseInstanceAddress(`https://ops.example.test${mount}/accept-invite/inv_a-B_1`),
    ).toEqual({
      origin: `https://ops.example.test${mount}`,
      nextPath: "/accept-invite/inv_a-B_1",
    });
  });
  it("keeps explicit loopback addresses for local instances", () => {
    expect(parseInstanceAddress("http://127.0.0.1:4000")).toEqual({
      origin: "http://127.0.0.1:4000",
      nextPath: "/login",
    });
  });
});
