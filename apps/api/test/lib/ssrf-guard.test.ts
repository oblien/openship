import { describe, expect, it } from "vitest";

import {
  SsrfError,
  assertPublicHostLiteral,
  assertPublicUrlLiteral,
  isBlockedHostname,
  isPrivateIp,
} from "../../src/lib/ssrf-guard";

// The literal (sync, no-DNS) half of the guard — the create/update-time reject.
// Fetch-time DNS pinning is covered by safe-fetch.test.ts.
describe("isPrivateIp", () => {
  it("rejects the classic private and loopback v4 ranges", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "0.0.0.0"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("rejects link-local, CGNAT, and cloud metadata", () => {
    for (const ip of ["169.254.169.254", "100.64.0.1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("rejects IPv6 loopback and unique-local", () => {
    for (const ip of ["::1", "[::1]", "fd00::1", "fe80::1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("rejects v4-mapped IPv6 in both dotted and hex form (the bypass vector)", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:7f00:1")).toBe(true);
    expect(isPrivateIp("::ffff:a9fe:a9fe")).toBe(true);
  });

  it("accepts globally routable addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });

  it("returns false for anything that isn't an IP literal (hostnames go to the hostname check)", () => {
    expect(isPrivateIp("example.com")).toBe(false);
    expect(isPrivateIp("")).toBe(false);
  });
});

describe("isBlockedHostname", () => {
  it("blocks loopback and internal-only suffixes", () => {
    for (const host of [
      "localhost",
      "ip6-localhost",
      "app.localhost",
      "svc.internal",
      "printer.local",
    ]) {
      expect(isBlockedHostname(host)).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isBlockedHostname("LOCALHOST")).toBe(true);
  });

  it("allows public hostnames", () => {
    expect(isBlockedHostname("hooks.example.com")).toBe(false);
  });

  it("does not block a public host that merely contains a blocked word", () => {
    expect(isBlockedHostname("localhost.example.com")).toBe(false);
    expect(isBlockedHostname("internal-tools.example.com")).toBe(false);
  });
});

describe("assertPublicHostLiteral", () => {
  it("accepts public hostnames and IPs", () => {
    expect(() => assertPublicHostLiteral("hooks.example.com")).not.toThrow();
    expect(() => assertPublicHostLiteral("8.8.8.8")).not.toThrow();
  });

  it("rejects private IPs, blocked hostnames, and empty input", () => {
    for (const host of ["127.0.0.1", "localhost", "169.254.169.254", ""]) {
      expect(() => assertPublicHostLiteral(host)).toThrow(SsrfError);
    }
  });

  it("strips brackets so a bare IPv6 literal is still classified", () => {
    expect(() => assertPublicHostLiteral("[::1]")).toThrow(SsrfError);
  });
});

describe("assertPublicUrlLiteral", () => {
  it("accepts public https URLs", () => {
    expect(() => assertPublicUrlLiteral("https://hooks.example.com/webhook")).not.toThrow();
    expect(() => assertPublicUrlLiteral("https://discord.com/api/webhooks/123")).not.toThrow();
  });

  it("is https-only unless allowHttp is set", () => {
    expect(() => assertPublicUrlLiteral("http://hooks.example.com")).toThrow(SsrfError);
    expect(() =>
      assertPublicUrlLiteral("http://hooks.example.com", { allowHttp: true }),
    ).not.toThrow();
  });

  it("rejects non-http(s) schemes even with allowHttp", () => {
    for (const url of ["file:///etc/passwd", "gopher://example.com", "ftp://example.com"]) {
      expect(() => assertPublicUrlLiteral(url, { allowHttp: true })).toThrow(SsrfError);
    }
  });

  it("rejects internal destinations", () => {
    for (const url of [
      "https://localhost/webhook",
      "https://127.0.0.1/webhook",
      "https://10.0.0.1/hook",
      "https://192.168.1.1/hook",
      "https://169.254.169.254/latest/meta-data/",
    ]) {
      expect(() => assertPublicUrlLiteral(url)).toThrow(SsrfError);
    }
  });

  it("rejects a private host regardless of port", () => {
    expect(() => assertPublicUrlLiteral("https://127.0.0.1:8080/hook")).toThrow(SsrfError);
  });

  it("rejects malformed URLs", () => {
    for (const url of ["not-a-url", "", "https://"]) {
      expect(() => assertPublicUrlLiteral(url)).toThrow(SsrfError);
    }
  });

  it("carries the 400/SSRF_BLOCKED contract callers map to a response", () => {
    try {
      assertPublicUrlLiteral("https://127.0.0.1/hook");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SsrfError);
      expect((err as SsrfError).status).toBe(400);
      expect((err as SsrfError).code).toBe("SSRF_BLOCKED");
    }
  });
});
