import { describe, expect, it } from "vitest";
import { createPublicEndpoint } from "@/context/deployment/types";
import {
  getWwwDomainRouting,
  setWwwDomainRouting,
  toggleWwwDomainRouting,
} from "./www-domain-routing";
import { validatedPublicEndpointPayload } from "./public-endpoint-payload";

const domain = (customDomain: string, extra = {}) =>
  createPublicEndpoint({
    domainType: "custom",
    customDomain,
    port: "3000",
    targetPath: "/",
    ...extra,
  });

describe("www domain behavior", () => {
  it("defaults an added www hostname to a permanent redirect with distinct IDs", () => {
    const bare = domain("example.com");
    const next = toggleWwwDomainRouting([bare], true);
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ ...bare, redirectTo: "" });
    expect(next[1]).toMatchObject({
      customDomain: "www.example.com",
      redirectTo: "example.com",
      redirectStatus: 301,
      port: "3000",
      targetPath: "/",
    });
    expect(next[1].id).not.toBe(bare.id);
    expect(getWwwDomainRouting(next)?.mode).toBe("apex");
    expect(toggleWwwDomainRouting(next, true)).toEqual(next);
  });
  it("keeps a typed www hostname primary when its bare sibling is added", () => {
    const next = toggleWwwDomainRouting([domain("www.example.com")], true);
    expect(next.map((e) => e.customDomain)).toEqual(["www.example.com", "example.com"]);
    expect(next[1]).toMatchObject({ redirectTo: "www.example.com", redirectStatus: 301 });
  });
  it("switches direction in one update and preserves other domains and targets", () => {
    const extra = domain("api.example.com", { port: "8080" });
    const initial = toggleWwwDomainRouting([domain("example.com"), extra], true);
    const www = setWwwDomainRouting(initial, "www");
    expect(www.map((e) => e.customDomain)).toEqual([
      "www.example.com",
      "example.com",
      "api.example.com",
    ]);
    expect(www[0].redirectTo).toBe("");
    expect(www[1].redirectTo).toBe(www[0].customDomain);
    expect(www[2]).toEqual(extra);
    const bare = setWwwDomainRouting(www, "apex");
    expect(getWwwDomainRouting(bare)?.mode).toBe("apex");
    expect(new Set(bare.map((e) => e.id))).toEqual(new Set(initial.map((e) => e.id)));
    expect(bare.filter((e) => e.redirectTo)).toHaveLength(1);
  });
  it("serve both clears redirects in the persisted project payload", () => {
    const both = setWwwDomainRouting(toggleWwwDomainRouting([domain("example.com")], true), "both");
    expect(getWwwDomainRouting(both)?.mode).toBe("both");
    for (const endpoint of both) {
      const payload = validatedPublicEndpointPayload(endpoint, true);
      expect(payload).not.toHaveProperty("redirectTo");
      expect(payload).not.toHaveProperty("redirectStatus");
    }
  });
  it("reuses the serving port when a portless redirect becomes primary", () => {
    const next = setWwwDomainRouting([
      domain("example.com"),
      domain("www.example.com", { port: "", redirectTo: "example.com" }),
    ], "www");
    expect(next[0]).toMatchObject({ customDomain: "www.example.com", redirectTo: "", port: "3000" });
    expect(validatedPublicEndpointPayload(next[0], true)).toMatchObject({ port: 3000 });
  });
  it("keeps the chosen primary when disabling www and repairs references to the removed host", () => {
    const both = setWwwDomainRouting([domain("example.com")], "www");
    const next = toggleWwwDomainRouting(
      [...both, domain("other.example.com", { redirectTo: "example.com", redirectStatus: 301 })],
      false,
    );
    expect(next.map((e) => e.customDomain)).toEqual(["www.example.com", "other.example.com"]);
    expect(next.every((e) => !e.redirectTo && !e.redirectStatus)).toBe(true);
  });
  it("preserves an existing serve-both choice when Include www is already enabled", () => {
    const existing = [domain("example.com"), domain("www.example.com")];
    expect(toggleWwwDomainRouting(existing, true)).toEqual(existing);
  });
  it("serves both on destinations without canonical redirect support", () => {
    const next = toggleWwwDomainRouting([domain("example.com")], true, false);
    expect(getWwwDomainRouting(next)?.mode).toBe("both");
    expect(next.every((e) => !e.redirectTo)).toBe(true);
  });
  it.each(["api.example.com", "www.api.example.com", "*.example.com", "localhost", ""])(
    "does not invent www for %s",
    (host) => {
      const initial = [domain(host)];
      expect(getWwwDomainRouting(initial)).toBeNull();
      expect(toggleWwwDomainRouting(initial, true)).toEqual(initial);
    },
  );
  it("normalizes typed hostnames and recognizes multi-part public suffixes", () => {
    const next = toggleWwwDomainRouting([domain("HTTPS://EXAMPLE.CO.UK/")], true);
    expect(getWwwDomainRouting(next)).toMatchObject({
      apex: "example.co.uk",
      included: true,
      mode: "apex",
    });
  });
});
