import { describe, expect, it } from "vitest";
import { parseContainerHosts } from "./container-hosts";

describe("container hostname mappings", () => {
  it("preserves IP addresses and Docker's dynamic host gateway across Compose forms", () => {
    expect(
      parseContainerHosts(["mail.example.com:host-gateway", "db=10.2.3.4", "ipv6=[::1]"]),
    ).toEqual({
      "mail.example.com": "host-gateway",
      db: "10.2.3.4",
      ipv6: "::1",
    });
    expect(parseContainerHosts({ db: "10.2.3.4", ipv6: "2001:db8::2" })).toEqual({
      db: "10.2.3.4",
      ipv6: "2001:db8::2",
    });
  });
  it("interpolates only addresses, keeping the certificate hostname intact", () => {
    expect(
      parseContainerHosts({ "mail.example.com": "${ADDRESS}" }, (value) =>
        value.replace("${ADDRESS}", "host-gateway"),
      ),
    ).toEqual({ "mail.example.com": "host-gateway" });
  });
  it.each([
    { "a\nb": "127.0.0.1" },
    { "a\n": "127.0.0.1" },
    { mail: "127.0.0.999" },
    { mail: "https://example.com" },
    { mail: "bad:address" },
    { mail: "::1]/path#[]" },
    { mail: 3 },
    ["mail"],
    [3],
    ["mail=127.0.0.1", "MAIL=127.0.0.2"],
  ])("refuses malformed or ambiguous mappings before deployment (%j)", (raw) => {
    expect(() => parseContainerHosts(raw)).toThrow();
  });
  it("never expands an escaped Compose value a second time", () => {
    const interpolate = (value: string) =>
      value.replace(/\$\$|\$\{ADDRESS\}/g, (match) => (match === "$$" ? "$" : "127.0.0.1"));
    expect(() => parseContainerHosts(["mail=$${ADDRESS}"], interpolate)).toThrow(/addresses/);
  });
  it("distinguishes omission from an explicit empty map", () => {
    expect(parseContainerHosts(undefined)).toBeUndefined();
    expect(parseContainerHosts({})).toEqual({});
  });
});
