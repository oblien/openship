import { describe, it, expect } from "vitest";
import { isCloudEdgeHost, isNonPublicHost } from "./edge-target";

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

  it("judges a URL / host:port on its address, not the whole string", () => {
    // Unnormalized, `https://127.0.0.1` and `localhost:3000` matched NONE of the
    // patterns and came back "publicly reachable" — the inverse of the truth.
    for (const h of [
      "https://127.0.0.1",
      "http://10.0.0.5/x",
      "https://localhost:3000",
      "http://192.168.1.10/",
      "https://[::1]/x",
      "[::1]:8080",
      "127.0.0.1:8080",
    ]) {
      expect(isNonPublicHost(h)).toBe(true);
    }
    expect(isNonPublicHost("https://ops.example.com/x")).toBe(false);
    expect(isNonPublicHost("ops.example.com:8443")).toBe(false);
  });

  it("still detects bare IPv6 ULA / link-local after normalization", () => {
    // GUARD, do not 'simplify': normalizing through the resolver's hostFrom would
    // split on ":" to drop a port, turning `fc00::1` into `fc00`. The ULA regex
    // needs a trailing ":", so it would stop matching and every ULA address would
    // read as public. Scheme-and-path stripping is the only safe normalization.
    for (const h of ["fc00::1", "fd12:3456::1", "fe80::1", "::1", "::"]) {
      expect(isNonPublicHost(h)).toBe(true);
    }
  });
});

/**
 * `isCloudEdgeHost` catches what `isNonPublicHost` deliberately can't: a
 * `.opsh.io` target is perfectly reachable, and that's the problem — Oblien
 * terminates `<slug>.opsh.io` and forwards to the target, so a `.opsh.io` target
 * re-enters the edge that just served the request. It's a live self-loop, not a
 * dead route, so the loopback guard reads it as fine.
 *
 * The reachable path into it: a free-domain install sets the box's
 * OPENSHIP_PUBLIC_URL to `https://<slug>.opsh.io`, and that is the FIRST candidate
 * the target resolver reads.
 */
describe("isCloudEdgeHost", () => {
  it("flags the cloud domain and any subdomain of it", () => {
    for (const h of ["opsh.io", "myapp.opsh.io", "retgfds.opsh.io", "a.b.opsh.io"]) {
      expect(isCloudEdgeHost(h)).toBe(true);
    }
  });

  it("is case- and trailing-dot-insensitive", () => {
    for (const h of ["MyApp.OPSH.IO", " myapp.opsh.io ", "myapp.opsh.io."]) {
      expect(isCloudEdgeHost(h)).toBe(true);
    }
  });

  it("normalizes URLs and host:port, since callers hold different shapes", () => {
    // The SaaS receiver checks a raw `target` that may carry a scheme; the resolver
    // checks OPENSHIP_PUBLIC_URL, which always does. A bare suffix check would let
    // both through — `https://x.opsh.io/y` doesn't end with `.opsh.io`.
    for (const h of [
      "https://myapp.opsh.io",
      "http://myapp.opsh.io/some/path",
      "myapp.opsh.io:8080",
      "https://myapp.opsh.io:443/x",
    ]) {
      expect(isCloudEdgeHost(h)).toBe(true);
    }
  });

  it("does not flag real origins, including lookalikes", () => {
    // `notopsh.io` and `opsh.io.evil.com` must NOT match: a suffix check written as
    // a bare `includes`/`endsWith("opsh.io")` would wrongly reject the first and
    // wrongly accept nothing — the label boundary is what makes this correct.
    for (const h of ["203.0.113.10", "ops.example.com", "notopsh.io", "opsh.io.evil.com", ""]) {
      expect(isCloudEdgeHost(h)).toBe(false);
    }
  });

  it("stays disjoint from isNonPublicHost — a cloud host IS publicly routable", () => {
    expect(isNonPublicHost("myapp.opsh.io")).toBe(false);
    expect(isCloudEdgeHost("myapp.opsh.io")).toBe(true);
  });
});
