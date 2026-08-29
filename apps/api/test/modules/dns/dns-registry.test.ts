import { describe, it, expect } from "vitest";
import {
  resolveDnsProvider,
  listDnsProviders,
  describeDnsProviders,
} from "../../../src/modules/dns/registry";
import { UnknownDnsProviderError } from "../../../src/modules/dns/types";

describe("dns registry", () => {
  it("resolves the registered cloudflare provider", () => {
    expect(resolveDnsProvider("cloudflare").name).toBe("cloudflare");
  });

  it("throws UnknownDnsProviderError for an unknown provider", () => {
    expect(() => resolveDnsProvider("unsupported")).toThrow(UnknownDnsProviderError);
  });

  it("maps an unknown provider to a 400, not a 500", () => {
    // It's a bad request, not a server fault — handleApiError reads statusCode.
    const err = new UnknownDnsProviderError("route53");
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("DNS_UNKNOWN_PROVIDER");
  });

  it("lists every registered provider", () => {
    expect(listDnsProviders()).toContain("cloudflare");
  });

  it("DERIVES descriptors from the registry, so a new provider cannot be invisible", () => {
    // The dashboard picker renders this list. A hand-maintained second literal is
    // how a registered provider ends up unusable from the UI.
    const descriptors = describeDnsProviders();
    expect(descriptors.map((d) => d.name).sort()).toEqual([...listDnsProviders()].sort());
  });

  it("describes the exact token scopes needed, so a minimal token can be minted", () => {
    const cf = describeDnsProviders().find((d) => d.name === "cloudflare");
    expect(cf?.requiredScopes).toEqual(["Zone:Zone:Read", "Zone:DNS:Edit"]);
    expect(cf?.displayName).toBe("Cloudflare");
    expect(cf?.tokenUrl).toContain("dash.cloudflare.com");
  });
});
