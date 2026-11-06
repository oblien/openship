import { describe, expect, it } from "vitest";

import { ipAddressVersion, isLoopbackHost } from "./network";
import { isIP } from "node:net";

describe("strict IP address inputs", () => {
  it.each([
    "0.0.0.0",
    "255.255.255.255",
    "203.0.113.10",
    "::",
    "::1",
    "2001:db8::1",
    "::ffff:192.0.2.128",
    "1:2:3:4:5:6:192.0.2.1",
  ])("matches Node for %s", (address) => {
    expect(ipAddressVersion(address)).toBe(isIP(address));
    expect(ipAddressVersion(address)).not.toBe(0);
  });
  it.each([
    "",
    "--all",
    "localhost",
    "1.2.3",
    "1.2.3.256",
    "01.2.3.4",
    "1.2.3.4/24",
    "[::1]",
    "fe80::1%eth0",
    " 1.2.3.4",
    "::1\n",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    "::ffff:999.0.0.1",
  ])("rejects non-address input %j", (address) => {
    expect(ipAddressVersion(address)).toBe(0);
  });
});

describe("isLoopbackHost", () => {
  it.each([
    "localhost",
    "api.localhost.",
    "localhost.localdomain",
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "::",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
    "[0:0:0:0:0:ffff:7f00:1]",
    "::7f00:1",
  ])("recognizes local connect target %s", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    "example.com",
    "localhost.example.com",
    "10.0.0.1",
    "126.255.255.255",
    "128.0.0.1",
    "::2",
    "::ffff:10.0.0.1",
    "127.0.0.999",
  ])("does not classify non-loopback target %s", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});
