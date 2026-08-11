import { describe, expect, it } from "vitest";
import { createPublicEndpoint } from "@/context/deployment/types";
import {
  redirectPayloadFields,
  resolvePublicEndpointHostname,
  validatedPublicEndpointPayload,
} from "./public-endpoint-payload";

/**
 * The endpoint list a client submits is AUTHORITATIVE: an omitted redirect clears
 * the stored one. Every payload builder therefore has to carry it, and there are
 * several (two saves, two deploy shapes, plus the read paths that feed them). The
 * redirect work hit that four separate times — a save, a deploy, a build-session
 * restore and the www toggle itself each dropped it and silently turned a
 * redirecting domain back into one that serves the app.
 */

const server = (over: Parameters<typeof createPublicEndpoint>[0] = {}) =>
  createPublicEndpoint({ domainType: "custom", customDomain: "www.example.com", port: "3000", ...over });

describe("redirectPayloadFields", () => {
  it("carries the target and defaults the status to 301", () => {
    expect(redirectPayloadFields({ redirectTo: "example.com" })).toEqual({
      redirectTo: "example.com",
      redirectStatus: 301,
    });
  });

  it("keeps an explicit status", () => {
    expect(redirectPayloadFields({ redirectTo: "example.com", redirectStatus: 302 })).toEqual({
      redirectTo: "example.com",
      redirectStatus: 302,
    });
  });

  // A serving endpoint's payload must be EXACTLY what it was before redirects
  // existed — no `redirectTo: undefined` key that a strict schema could reject.
  it("adds nothing at all when the endpoint serves the app", () => {
    expect(redirectPayloadFields({})).toEqual({});
    expect(Object.keys(redirectPayloadFields({ redirectTo: "" }))).toHaveLength(0);
  });
});

describe("validatedPublicEndpointPayload", () => {
  it("carries the redirect through a server-route save", () => {
    expect(
      validatedPublicEndpointPayload(server({ redirectTo: "example.com" }), true),
    ).toEqual({
      port: 3000,
      domainType: "custom",
      customDomain: "www.example.com",
      redirectTo: "example.com",
      redirectStatus: 301,
    });
  });

  it("carries the redirect through a static-route save", () => {
    const payload = validatedPublicEndpointPayload(
      createPublicEndpoint({
        domainType: "custom",
        customDomain: "www.example.com",
        targetPath: "/",
        redirectTo: "example.com",
      }),
      false,
    );
    expect(payload).toMatchObject({ targetPath: "/", redirectTo: "example.com", redirectStatus: 301 });
  });

  // Guards the normal flow: a domain with no redirect serializes to the same shape
  // it always did, so nothing about an ordinary save changed.
  it("leaves a non-redirecting endpoint's payload untouched", () => {
    expect(validatedPublicEndpointPayload(server(), true)).toEqual({
      port: 3000,
      domainType: "custom",
      customDomain: "www.example.com",
    });
  });

  it("still refuses an incomplete row", () => {
    expect(validatedPublicEndpointPayload(server({ customDomain: "" }), true)).toBeNull();
    expect(validatedPublicEndpointPayload(server({ port: "0" }), true)).toBeNull();
    expect(validatedPublicEndpointPayload(server({ port: "not-a-port" }), true)).toBeNull();
    expect(
      validatedPublicEndpointPayload(createPublicEndpoint({ domainType: "free", port: "3000" }), true),
    ).toBeNull();
  });

  it("normalizes the hostname it saves", () => {
    expect(
      validatedPublicEndpointPayload(server({ customDomain: "  WWW.Example.COM " }), true),
    ).toMatchObject({ customDomain: "www.example.com" });
  });

  // #342: the API now rejects a bogus custom hostname, and it normalizes with
  // `normalizeCustomHostname` (scheme + trailing slash stripped) before checking.
  // Saving a differently-normalized value here would send `https://example.com`
  // where the API expects `example.com` — accepted by POST /domains and the service
  // routing patch, so it has to be accepted on this path too.
  it("strips a pasted scheme and trailing slash, like the API", () => {
    expect(
      validatedPublicEndpointPayload(server({ customDomain: "HTTPS://App.Example.com/" }), true),
    ).toMatchObject({ customDomain: "app.example.com" });
  });
});

describe("resolvePublicEndpointHostname", () => {
  it("prefers a pre-resolved hostname", () => {
    expect(
      resolvePublicEndpointHostname({ hostname: "WWW.Example.com ", domainType: "free" }, "opsh.io"),
    ).toBe("www.example.com");
  });

  it("resolves a free slug against the base domain", () => {
    expect(
      resolvePublicEndpointHostname({ domainType: "free", domain: "my-app" }, "opsh.io"),
    ).toBe("my-app.opsh.io");
  });

  it("resolves a custom hostname", () => {
    expect(
      resolvePublicEndpointHostname({ domainType: "custom", customDomain: "Example.com" }, "opsh.io"),
    ).toBe("example.com");
  });

  // A blank row can't be offered as a redirect target.
  it("returns empty for a row with no hostname yet", () => {
    expect(resolvePublicEndpointHostname({ domainType: "custom", customDomain: "" }, "opsh.io")).toBe("");
    expect(resolvePublicEndpointHostname({ domainType: "free", domain: "" }, "opsh.io")).toBe("");
  });
});
