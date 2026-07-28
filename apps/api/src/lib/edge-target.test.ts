import { describe, it, expect } from "vitest";
import { isNonPublicHost } from "./edge-target";

/**
 * `isNonPublicHost` is the guard that stops a free `.opsh.io` route from being
 * wired at a host Openship Cloud can't reach (the root cause of the 404: an
 * `isLocal` box's display `sshHost` is `127.0.0.1`, which Oblien would proxy to
 * its OWN loopback). A false negative here re-introduces the dead route, so the
 * ranges are pinned explicitly.
 */
describe("isNonPublicHost", () => {
  it("treats loopback + unspecified as non-public", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "0.0.0.0", "::", "[::1]"]) {
      expect(isNonPublicHost(h)).toBe(true);
    }
  });

  it("treats RFC-1918 + link-local as non-public", () => {
    for (const h of ["10.0.0.5", "192.168.1.10", "172.16.0.1", "172.31.255.255", "169.254.1.1"]) {
      expect(isNonPublicHost(h)).toBe(true);
    }
  });

  it("treats IPv6 ULA + link-local as non-public", () => {
    for (const h of ["fc00::1", "fd12:3456::1", "fe80::1"]) {
      expect(isNonPublicHost(h)).toBe(true);
    }
  });

  it("allows real public hosts", () => {
    for (const h of ["ops.example.com", "203.0.113.10", "8.8.8.8", "myapp.opsh.io", "172.32.0.1"]) {
      expect(isNonPublicHost(h)).toBe(false);
    }
  });

  it("empty / whitespace is non-public (fail-safe)", () => {
    expect(isNonPublicHost("")).toBe(true);
    expect(isNonPublicHost("   ")).toBe(true);
  });
});
