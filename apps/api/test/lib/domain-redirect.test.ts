import { describe, expect, it } from "vitest";
import { ValidationError } from "@repo/core";
import {
  assertRedirectSupported,
  assertRedirectTargets,
  normalizeRedirect,
  resolveRedirectStatus,
  resolveRouteRedirect,
} from "../../src/lib/domain-redirect";

describe("normalizeRedirect", () => {
  it("normalizes a target the way hostnames are normalized everywhere else", () => {
    expect(normalizeRedirect({ redirectTo: " HTTPS://Example.COM/ " })).toEqual({
      redirectTo: "example.com",
      redirectStatus: 301,
    });
  });

  it("treats an empty/absent target as no redirect, and drops the status with it", () => {
    expect(normalizeRedirect({})).toEqual({ redirectTo: null, redirectStatus: null });
    expect(normalizeRedirect({ redirectTo: "", redirectStatus: 302 })).toEqual({
      redirectTo: null,
      redirectStatus: null,
    });
  });

  it("defaults to 301 and honours the other redirect codes", () => {
    expect(normalizeRedirect({ redirectTo: "example.com" }).redirectStatus).toBe(301);
    for (const status of [301, 302, 307, 308]) {
      expect(normalizeRedirect({ redirectTo: "example.com", redirectStatus: status }).redirectStatus)
        .toBe(status);
    }
  });

  // Rejected rather than silently coerced: a caller asking for 200 has a bug, and
  // quietly answering 301 would hide it.
  it("REFUSES a status that isn't a redirect", () => {
    expect(() => normalizeRedirect({ redirectTo: "example.com", redirectStatus: 200 })).toThrow(
      ValidationError,
    );
    expect(() => normalizeRedirect({ redirectTo: "example.com", redirectStatus: 404 })).toThrow(
      ValidationError,
    );
  });
});

describe("assertRedirectTargets", () => {
  it("accepts a redirect to another hostname of the same project", () => {
    expect(() =>
      assertRedirectTargets([
        { hostname: "example.com" },
        { hostname: "www.example.com", redirectTo: "example.com" },
      ]),
    ).not.toThrow();
  });

  // The whole point of a closed target list: a verified domain holding a valid
  // certificate must not become an open redirect for someone else's traffic.
  it("REFUSES a target outside the project", () => {
    expect(() =>
      assertRedirectTargets([
        { hostname: "example.com" },
        { hostname: "www.example.com", redirectTo: "evil.example.net" },
      ]),
    ).toThrow(/only redirect to another domain of this project/);
  });

  it("REFUSES a self-redirect", () => {
    expect(() =>
      assertRedirectTargets([{ hostname: "example.com", redirectTo: "example.com" }]),
    ).toThrow(/can't redirect to itself/);
  });

  it("REFUSES a two-host loop", () => {
    expect(() =>
      assertRedirectTargets([
        { hostname: "example.com", redirectTo: "www.example.com" },
        { hostname: "www.example.com", redirectTo: "example.com" },
      ]),
    ).toThrow(/redirect loop/);
  });

  it("REFUSES a longer loop", () => {
    expect(() =>
      assertRedirectTargets([
        { hostname: "a.example.com", redirectTo: "b.example.com" },
        { hostname: "b.example.com", redirectTo: "c.example.com" },
        { hostname: "c.example.com", redirectTo: "a.example.com" },
      ]),
    ).toThrow(/redirect loop/);
  });

  // A chain that ENDS somewhere is fine — old → new → canonical is a normal
  // domain migration, not a loop.
  it("allows a terminating chain", () => {
    expect(() =>
      assertRedirectTargets([
        { hostname: "old.example.com", redirectTo: "new.example.com" },
        { hostname: "new.example.com", redirectTo: "example.com" },
        { hostname: "example.com" },
      ]),
    ).not.toThrow();
  });

  it("compares hostnames case- and scheme-insensitively", () => {
    expect(() =>
      assertRedirectTargets([
        { hostname: "Example.com" },
        { hostname: "WWW.example.com", redirectTo: "https://example.com/" },
      ]),
    ).not.toThrow();
  });
});

describe("assertRedirectSupported", () => {
  it("refuses a cloud project, naming the reason", () => {
    expect(() => assertRedirectSupported({ isCloudProject: true, hostname: "www.example.com" }))
      .toThrow(/Openship Cloud/);
  });

  it("allows a self-hosted project", () => {
    expect(() =>
      assertRedirectSupported({ isCloudProject: false, hostname: "www.example.com" }),
    ).not.toThrow();
  });
});

describe("resolveRouteRedirect", () => {
  const live = ["example.com", "www.example.com"];

  it("resolves a live redirect with its status", () => {
    expect(
      resolveRouteRedirect(
        { hostname: "www.example.com", redirectTo: "example.com", redirectStatus: 302 },
        live,
      ),
    ).toEqual({ target: "example.com", statusCode: 302 });
  });

  it("defaults a missing status to 301", () => {
    expect(
      resolveRouteRedirect({ hostname: "www.example.com", redirectTo: "example.com" }, live),
    ).toEqual({ target: "example.com", statusCode: 301 });
  });

  it("returns null when there's no redirect", () => {
    expect(resolveRouteRedirect({ hostname: "example.com" }, live)).toBeNull();
  });

  // Routing must never fail a deploy, so a target that has since been removed
  // DROPS the redirect and serves — better than 301-ing every visitor to a
  // hostname this box no longer answers for.
  it("drops a redirect whose target is no longer routed", () => {
    expect(
      resolveRouteRedirect(
        { hostname: "www.example.com", redirectTo: "gone.example.com" },
        live,
      ),
    ).toBeNull();
  });

  it("drops a self-redirect rather than emitting an infinite loop", () => {
    expect(
      resolveRouteRedirect({ hostname: "example.com", redirectTo: "example.com" }, live),
    ).toBeNull();
  });
});

describe("resolveRedirectStatus", () => {
  it("falls back to 301 for anything that isn't a redirect code", () => {
    expect(resolveRedirectStatus(null)).toBe(301);
    expect(resolveRedirectStatus(undefined)).toBe(301);
    expect(resolveRedirectStatus(200)).toBe(301);
    expect(resolveRedirectStatus(308)).toBe(308);
  });
});
