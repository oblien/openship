import { describe, expect, it } from "vitest";

import { findUntrackedEdgeSites, type EdgeSiteInput } from "../src/edge-orphans";
// Lives in utils (shared with isApexDomain and the domain-claim path) rather than
// here — the sweep is a consumer, not the owner.
import { normalizeServedHostname } from "../src/utils";

const proxySite = (names: string[], url = "http://127.0.0.1:3000"): EdgeSiteInput => ({
  serverNames: names,
  ssl: true,
  target: { kind: "proxy", url },
});

const staticSite = (names: string[], root = "/opt/openship/static/releases/dep_1"): EdgeSiteInput => ({
  serverNames: names,
  ssl: true,
  target: { kind: "static", root },
});

describe("findUntrackedEdgeSites", () => {
  it("reports a vhost whose hostname Openship has no record of", () => {
    const out = findUntrackedEdgeSites({
      sites: [staticSite(["forgotten.example.com"])],
      knownHostnames: ["live.example.com"],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.hostname).toBe("forgotten.example.com");
    expect(out[0]!.kind).toBe("static");
    expect(out[0]!.target).toBe("/opt/openship/static/releases/dep_1");
  });

  it("says nothing about a tracked vhost", () => {
    const out = findUntrackedEdgeSites({
      sites: [proxySite(["live.example.com"])],
      knownHostnames: ["live.example.com"],
    });
    expect(out).toEqual([]);
  });

  /**
   * The apex+www case. One file serves both, so a single known name means the
   * file is accounted for. Requiring ALL names to be known would flag every
   * apex+www vhost the moment one side left the DB — a false positive on a
   * perfectly live domain.
   */
  it("treats a vhost as tracked when ANY of its server_names is known", () => {
    const out = findUntrackedEdgeSites({
      sites: [proxySite(["example.com", "www.example.com"])],
      knownHostnames: ["example.com"],
    });
    expect(out).toEqual([]);
  });

  it("reports every hostname on a vhost once none of them is known", () => {
    const out = findUntrackedEdgeSites({
      sites: [staticSite(["old.example.com", "www.old.example.com"])],
      knownHostnames: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.hostnames).toEqual(["old.example.com", "www.old.example.com"]);
  });

  it("matches hostnames case-insensitively and ignores a trailing root dot", () => {
    const out = findUntrackedEdgeSites({
      sites: [proxySite(["API.Example.COM."])],
      knownHostnames: ["api.example.com"],
    });
    expect(out).toEqual([]);
  });

  /**
   * Non-hostname server_names. Reporting any of these would put permanent noise
   * in an operator-facing list, which is how a report stops being read.
   */
  it.each([
    ["nginx catch-all", "_"],
    ["loopback", "localhost"],
    ["managed-subdomain wildcard", "*.opsh.io"],
    ["bare IPv4 default vhost", "203.0.113.10"],
    ["no dot, so not a claimable domain", "internal"],
  ])("never reports the %s server_name", (_label, name) => {
    const out = findUntrackedEdgeSites({ sites: [proxySite([name])], knownHostnames: [] });
    expect(out).toEqual([]);
  });

  it("skips a vhost with no reportable name at all rather than emitting a blank row", () => {
    const out = findUntrackedEdgeSites({
      sites: [{ serverNames: ["_", "localhost"], ssl: false, target: { kind: "static", root: "/x" } }],
      knownHostnames: [],
    });
    expect(out).toEqual([]);
  });

  /**
   * Static ranks first: it keeps serving the old project's files with a 200, so
   * it's the case an operator must see. A dead proxy vhost is already 502ing and
   * announces itself.
   */
  it("ranks static ahead of proxy, then sorts stably by hostname", () => {
    const out = findUntrackedEdgeSites({
      sites: [
        proxySite(["z-proxy.example.com"]),
        staticSite(["b-static.example.com"]),
        proxySite(["a-proxy.example.com"]),
        staticSite(["a-static.example.com"]),
      ],
      knownHostnames: [],
    });
    expect(out.map((s) => s.hostname)).toEqual([
      "a-static.example.com",
      "b-static.example.com",
      "a-proxy.example.com",
      "z-proxy.example.com",
    ]);
  });

  it("keeps the source file for traceability when the scanner supplies one", () => {
    const out = findUntrackedEdgeSites({
      sites: [{ ...staticSite(["x.example.com"]), source: "/etc/openresty/sites-enabled/x.conf" }],
      knownHostnames: [],
    });
    expect(out[0]!.source).toBe("/etc/openresty/sites-enabled/x.conf");
  });

  it("de-duplicates a vhost the scanner reported twice", () => {
    const out = findUntrackedEdgeSites({
      sites: [staticSite(["dup.example.com"]), staticSite(["dup.example.com"])],
      knownHostnames: [],
    });
    expect(out).toHaveLength(1);
  });

  it("an empty known-set does not mean 'everything is fine'", () => {
    // Guard against a caller that fails to load the DB and passes []: the sweep
    // must then report everything, not silently nothing.
    const out = findUntrackedEdgeSites({
      sites: [proxySite(["a.example.com"]), staticSite(["b.example.com"])],
      knownHostnames: [],
    });
    expect(out).toHaveLength(2);
  });
});

describe("normalizeServedHostname (the comparison form this sweep depends on)", () => {
  it("lowercases, trims, and drops the FQDN root dot", () => {
    // `server_name example.com.;` is legal nginx, so without the root-dot strip the
    // sweep would fail to match a domain against its own row and report it.
    expect(normalizeServedHostname("  Example.COM. ")).toBe("example.com");
  });
});
