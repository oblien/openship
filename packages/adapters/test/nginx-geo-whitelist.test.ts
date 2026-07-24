import { describe, expect, it } from "vitest";

import { renderGeoEntries } from "../src/infra/nginx";

// The `geo $whitelist` block needs whitespace between the CIDR and its `1;`
// value. Padding to a fixed 16 columns is a no-op once the CIDR is already
// that long, which silently emits `192.168.100.0/241;` - nginx then parses an
// address with no value, `openresty -t` fails, and applyRateLimit rolls the
// whole change back. Every IPv6 prefix and plenty of IPv4 CIDRs hit this.

/** The same pattern getRateLimitConfig() uses to read the block back. */
const READ_BACK = /^\s+([\da-fA-F.:\/]+)\s+1;/;

describe("renderGeoEntries", () => {
  it("always separates the CIDR from its value, whatever the length", () => {
    const cidrs = [
      "10.0.0.0/8", // 10 chars
      "172.16.0.0/12", // 13
      "192.168.100.0/24", // 16 - exactly the old pad width
      "203.0.113.100/32", // 16
      "2001:db8:1234:5678::/64", // 23 - IPv6 prefixes are always long
    ];

    for (const entry of renderGeoEntries(cidrs).slice(3)) {
      expect(entry).toMatch(/\s1;$/);
      expect(entry).not.toMatch(/[\da-fA-F.:\/]1;$/);
    }
  });

  it("round-trips every entry through the getRateLimitConfig reader", () => {
    const cidrs = ["10.0.0.0/8", "192.168.100.0/24", "2001:db8:1234:5678::/64"];

    const read = renderGeoEntries(cidrs)
      .map((line) => line.match(READ_BACK)?.[1])
      .filter(
        (cidr): cidr is string => Boolean(cidr) && cidr !== "127.0.0.1/32" && cidr !== "::1/128",
      );

    expect(read).toEqual(cidrs);
  });

  it("keeps the existing 16-column layout for short CIDRs", () => {
    // Byte-identical to the previous output, so applying an unchanged config
    // doesn't rewrite the file.
    expect(renderGeoEntries(["10.0.0.0/8"])).toEqual([
      "        default         0;",
      "        127.0.0.1/32    1;",
      "        ::1/128         1;",
      "        10.0.0.0/8      1;",
    ]);
  });

  it("emits only the loopback defaults for an empty whitelist", () => {
    expect(renderGeoEntries([])).toEqual([
      "        default         0;",
      "        127.0.0.1/32    1;",
      "        ::1/128         1;",
    ]);
  });

  it("still drops CIDRs that fail the injection guard", () => {
    const entries = renderGeoEntries([
      "10.0.0.0/8; return 444", // spaces/semicolon - config injection
      "10.0.0.0/8\n        evil 1;", // newline injection
      "1".repeat(51), // over the 50-char cap
      "10.1.0.0/16", // the one good entry
    ]);

    expect(entries).toEqual([
      "        default         0;",
      "        127.0.0.1/32    1;",
      "        ::1/128         1;",
      "        10.1.0.0/16     1;",
    ]);
  });
});
