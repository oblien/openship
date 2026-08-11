import { describe, expect, it } from "vitest";
import { ValidationError } from "@repo/core";
import {
  assertValidCustomDomain,
  assertValidCustomDomains,
} from "../../src/lib/custom-domain-guard";

/**
 * #342: the project write paths stored `publicEndpoints[].customDomain` verbatim.
 * Three of the shapes below pass nginx's own DOMAIN_RE, so they became a real
 * vhost (`server_name localhost;`) on the shared edge; the rest left a dead domain
 * row and a deploy warning. POST /domains and the service routing patch already
 * refused all of them.
 */
const REJECTED = [
  "https://example.com/app",
  "example.com/../../etc/passwd",
  "localhost",
  "127.0.0.1",
  "example.com:8080",
  "single",
  "a b.com",
  "app.example.",
  "a",
  "https://",
];

const ACCEPTED = ["example.com", "app.example.com", "  EXAMPLE.COM  ", "my-app.co.uk"];

describe("assertValidCustomDomain", () => {
  for (const host of REJECTED) {
    it(`rejects ${JSON.stringify(host)}`, () => {
      expect(() => assertValidCustomDomain(host)).toThrow(ValidationError);
      expect(() => assertValidCustomDomain(host)).toThrow(/is not a valid custom domain/);
    });
  }

  for (const host of ACCEPTED) {
    it(`accepts ${JSON.stringify(host)}`, () => {
      expect(() => assertValidCustomDomain(host)).not.toThrow();
    });
  }

  // An empty custom domain is dropped by normalization (and reported by preflight
  // as "cannot be empty"). Failing it here would reject the routing card's
  // switched-to-custom-but-not-yet-typed state on every save.
  it("passes a blank or absent value", () => {
    expect(() => assertValidCustomDomain("")).not.toThrow();
    expect(() => assertValidCustomDomain("   ")).not.toThrow();
    expect(() => assertValidCustomDomain(null)).not.toThrow();
    expect(() => assertValidCustomDomain(undefined)).not.toThrow();
  });

  // The siblings strip the scheme BEFORE validating, so the message has to name
  // the hostname that would have been stored, not the raw paste.
  it("reports the normalized hostname", () => {
    expect(() => assertValidCustomDomain("HTTPS://Local host/")).toThrow(
      /"local host" is not a valid custom domain/,
    );
  });
});

describe("assertValidCustomDomains", () => {
  it("checks a row's scalar hostname and its multi-route endpoints", () => {
    expect(() =>
      assertValidCustomDomains([{ domainType: "custom", customDomain: "localhost" }]),
    ).toThrow(ValidationError);

    expect(() =>
      assertValidCustomDomains([
        { publicEndpoints: [{ domainType: "custom", customDomain: "app.example.com" }] },
        { publicEndpoints: [{ domainType: "custom", customDomain: "127.0.0.1" }] },
      ]),
    ).toThrow(/"127.0.0.1"/);
  });

  // Only a row that will actually STORE the hostname is checked: normalization
  // drops `customDomain` on a free row, so rejecting it would fail payloads that
  // are harmless today (a card that kept the field while switching to free).
  it("ignores a customDomain left on a free row", () => {
    expect(() =>
      assertValidCustomDomains([
        { domainType: "free", customDomain: "localhost" },
        { publicEndpoints: [{ domainType: "free", customDomain: "127.0.0.1" }] },
      ]),
    ).not.toThrow();
  });

  it("tolerates empty / absent carriers", () => {
    expect(() => assertValidCustomDomains([null, undefined, {}, { publicEndpoints: null }])).not.toThrow();
  });
});

/**
 * The submitted endpoint list is AUTHORITATIVE, so every save echoes the whole set
 * back. Without the `known` exemption, a project holding a bad hostname — one
 * persisted before this gate, or a `localhost` vhost adopted by a server migration —
 * could never save a domain edit again, not even the edit that removes it. Same rule
 * as the free-endpoint gate: refuse to INTRODUCE, not to let go.
 */
describe("assertValidCustomDomains known-hostname exemption", () => {
  const carriers = [{ publicEndpoints: [{ domainType: "custom", customDomain: "localhost" }] }];

  it("lets an already-stored bad hostname through", () => {
    expect(() => assertValidCustomDomains(carriers, { known: ["localhost"] })).not.toThrow();
  });

  it("matches the stored hostname after normalization", () => {
    expect(() =>
      assertValidCustomDomains([{ domainType: "custom", customDomain: "  LOCALHOST " }], {
        known: ["localhost"],
      }),
    ).not.toThrow();
  });

  it("still refuses a NEW bad hostname on a project that has one", () => {
    expect(() =>
      assertValidCustomDomains(
        [{ publicEndpoints: [{ domainType: "custom", customDomain: "127.0.0.1" }] }],
        { known: ["localhost"] },
      ),
    ).toThrow(/"127.0.0.1"/);
  });

  it("refuses it again once the project no longer has it", () => {
    expect(() => assertValidCustomDomains(carriers, { known: ["app.example.com"] })).toThrow(
      ValidationError,
    );
  });
});
