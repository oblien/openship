import { describe, expect, it } from "vitest";

import { normalizeCustomHostname, isValidCustomHostname, isApexDomain } from "../src/utils";

describe("normalizeCustomHostname", () => {
  it("produces one canonical form so storage and lookup always agree", () => {
    // scheme + trailing slash + case + whitespace all collapse to the same host
    const variants = [
      "app.example.com",
      "APP.Example.com",
      "  app.example.com  ",
      "https://app.example.com",
      "http://app.example.com/",
      "https://APP.example.com///",
    ];
    for (const v of variants) {
      expect(normalizeCustomHostname(v)).toBe("app.example.com");
    }
  });

  it("is idempotent (canonical input is unchanged)", () => {
    const canonical = "api.acme.io";
    expect(normalizeCustomHostname(canonical)).toBe(canonical);
    expect(normalizeCustomHostname(normalizeCustomHostname("HTTPS://Api.Acme.io/"))).toBe(canonical);
  });

  it("returns empty for blank/scheme-only input", () => {
    expect(normalizeCustomHostname("")).toBe("");
    expect(normalizeCustomHostname("   ")).toBe("");
    expect(normalizeCustomHostname("https://")).toBe("");
  });

  // Regression guard: the www-strip belongs at the apex INPUT layer only. The
  // shared normalizer backs service-route storage AND domain lookups, and the
  // www toggle stores `www.<apex>` as its own endpoint — stripping www here would
  // collapse that endpoint and make www-primary hosts unroutable.
  it("does NOT strip a www. prefix", () => {
    expect(normalizeCustomHostname("www.example.com")).toBe("www.example.com");
    expect(normalizeCustomHostname("HTTPS://WWW.Example.com/")).toBe("www.example.com");
  });
});

describe("isApexDomain", () => {
  it("is true for registrable apex domains", () => {
    for (const h of ["example.com", "acme.io", "example.co.uk", "shop.com.au", "example.co.nz"]) {
      expect(isApexDomain(h)).toBe(true);
    }
  });

  it("is false for subdomains (www.<apex> makes no sense there)", () => {
    for (const h of [
      "www.example.com",
      "app.example.com",
      "api.acme.io",
      "fresh.hekai.org",
      "foo.example.co.uk", // subdomain under a multi-part TLD
    ]) {
      expect(isApexDomain(h)).toBe(false);
    }
  });

  it("is false for a bare public suffix or invalid host", () => {
    for (const h of ["co.uk", "com", "localhost", "", "1.2.3.4"]) {
      expect(isApexDomain(h)).toBe(false);
    }
  });

  it("normalizes casing / trailing dot before classifying", () => {
    expect(isApexDomain("Example.COM")).toBe(true);
    expect(isApexDomain("example.com.")).toBe(true);
    expect(isApexDomain("WWW.example.com")).toBe(false);
  });
});

describe("isValidCustomHostname", () => {
  it("accepts real multi-label public hostnames", () => {
    for (const h of ["example.com", "app.example.com", "a.b.c.example.co.uk", "xn--80ak6aa92e.com"]) {
      expect(isValidCustomHostname(h)).toBe(true);
    }
  });

  it("rejects the shapes a bare host must never contain", () => {
    for (const h of [
      "",
      "localhost",
      "example", // single label
      "1.2.3.4", // IPv4 literal
      "example.com/app", // embedded path
      "example.com:8080", // port
      "ftp://example.com", // non-http scheme leftover
      "//example.com", // protocol-relative leftover
      ".example.com", // leading dot
      "example.com.", // trailing dot
      "a..b.com", // empty label
      "exa mple.com", // whitespace
      `${"a".repeat(64)}.example.com`, // label over the 63-octet DNS limit
    ]) {
      expect(isValidCustomHostname(h)).toBe(false);
    }
  });

  it("accepts a label at exactly the 63-octet DNS limit", () => {
    expect(isValidCustomHostname(`${"a".repeat(63)}.example.com`)).toBe(true);
  });
});
