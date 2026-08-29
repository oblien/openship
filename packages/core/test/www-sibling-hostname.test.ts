import { describe, expect, it } from "vitest";

import { wwwSiblingHostname } from "../src/utils";

/**
 * One rule for the "Include www" fan-out: the row the add path creates
 * (addWwwSibling), the SAN the cert covers (domain-ssl), and the DNS record the
 * setup panel shows (buildRecords) must all agree. Those were three inline
 * `www.${host}` prefixes, so a "no stacking www on www" guard could exist in one
 * and be missing in another — producing a `www.www.example.com` row, or a record
 * for a hostname that never gets one.
 */
describe("wwwSiblingHostname", () => {
  it("prefixes www for an apex and a subdomain", () => {
    expect(wwwSiblingHostname("example.com")).toBe("www.example.com");
    expect(wwwSiblingHostname("freshs.hekai.org")).toBe("www.freshs.hekai.org");
  });

  it("never stacks www on www", () => {
    expect(wwwSiblingHostname("www.example.com")).toBeNull();
  });

  it("normalizes before deciding, so a scheme/case/slash can't defeat the guard", () => {
    expect(wwwSiblingHostname("HTTPS://WWW.Example.com/")).toBeNull();
    expect(wwwSiblingHostname(" https://Example.com/ ")).toBe("www.example.com");
  });

  it("returns null when there's nothing usable to prefix", () => {
    expect(wwwSiblingHostname("")).toBeNull();
    expect(wwwSiblingHostname("   ")).toBeNull();
  });
});
