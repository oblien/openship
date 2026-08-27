import { describe, expect, it } from "vitest";

import { isLoopbackHost } from "./network";

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
