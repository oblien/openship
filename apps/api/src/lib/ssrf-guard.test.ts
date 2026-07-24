import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DNS so the resolve-and-check path is deterministic and offline. Each
// test sets what the hostname resolves to via `mockLookup`.
const mockLookup = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (host: string, opts: unknown) => mockLookup(host, opts),
}));

import {
  isPrivateIp,
  isBlockedHostLiteral,
  assertPublicHttpsUrl,
  SsrfBlockedError,
} from "./ssrf-guard";

describe("isPrivateIp", () => {
  it("flags IPv4 loopback / private / link-local / CGNAT / this-network", () => {
    for (const ip of [
      "127.0.0.1",
      "127.10.20.30",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "172.15.0.1",
      "172.32.0.1",
      "100.63.0.1",
      "192.167.0.1",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("flags IPv6 loopback / link-local / ULA / mapped-private", () => {
    for (const ip of [
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "fc00::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6 and mapped-public", () => {
    for (const ip of ["2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("returns false for non-IP strings", () => {
    expect(isPrivateIp("example.com")).toBe(false);
  });
});

describe("isBlockedHostLiteral", () => {
  it("blocks local DNS names and private IP literals", () => {
    for (const h of [
      "localhost",
      "foo.localhost",
      "printer.local",
      "metadata.google.internal",
      "svc.internal",
      "127.0.0.1",
      "[::1]",
      "169.254.169.254",
    ]) {
      expect(isBlockedHostLiteral(h), h).toBe(true);
    }
  });

  it("allows public names and IPs (DNS not consulted here)", () => {
    for (const h of ["example.com", "hooks.example.org", "8.8.8.8"]) {
      expect(isBlockedHostLiteral(h), h).toBe(false);
    }
  });
});

describe("assertPublicHttpsUrl", () => {
  beforeEach(() => mockLookup.mockReset());

  it("rejects non-HTTPS", async () => {
    await expect(assertPublicHttpsUrl("http://example.com/hook")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects a malformed URL", async () => {
    await expect(assertPublicHttpsUrl("not a url")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects literal private/metadata IPs without touching DNS", async () => {
    await expect(assertPublicHttpsUrl("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /private host/,
    );
    await expect(assertPublicHttpsUrl("https://127.0.0.1/")).rejects.toThrow(/private host/);
    await expect(assertPublicHttpsUrl("https://[::1]/")).rejects.toThrow(/private host/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects known-local DNS names", async () => {
    await expect(assertPublicHttpsUrl("https://metadata.google.internal/")).rejects.toThrow(
      /local host/,
    );
    await expect(assertPublicHttpsUrl("https://localhost/")).rejects.toThrow(/local host/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects DNS rebinding: public name that resolves to a private IP", async () => {
    mockLookup.mockResolvedValue([{ address: "169.254.169.254" }]);
    await expect(assertPublicHttpsUrl("https://rebind.attacker.example/")).rejects.toThrow(
      /resolves to a private address/,
    );
    expect(mockLookup).toHaveBeenCalledWith("rebind.attacker.example", { all: true });
  });

  it("rejects when ANY resolved address is private (mixed record set)", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34" }, { address: "10.0.0.5" }]);
    await expect(assertPublicHttpsUrl("https://mixed.example/")).rejects.toThrow(
      /resolves to a private address/,
    );
  });

  it("rejects a host that fails to resolve to any address", async () => {
    // Empty result set exercises the same "does not resolve" refusal as a
    // lookup error, without an eagerly-rejected mock promise.
    mockLookup.mockResolvedValue([]);
    await expect(assertPublicHttpsUrl("https://nope.example/")).rejects.toThrow(/does not resolve/);
  });

  it("allows a public name that resolves to public addresses", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    await expect(assertPublicHttpsUrl("https://hooks.example.com/x")).resolves.toBeUndefined();
  });
});
