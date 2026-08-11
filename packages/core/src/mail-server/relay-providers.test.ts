import { describe, expect, test } from "vitest";

import {
  RELAY_PROVIDERS,
  isRelayProviderId,
  relayMailFromRecords,
  relayProvider,
  relayProviderSpfInclude,
  resolveRelayHost,
} from "./relay-providers";

describe("relayProvider", () => {
  test("resolves a known id", () => {
    expect(relayProvider("ses").label).toBe("Amazon SES");
    expect(relayProvider("postmark").spfInclude).toBe("include:spf.mtasv.net");
  });

  test("unknown / missing ids fall back to custom", () => {
    // State written by a newer build (or hand-edited) must not silently inherit
    // another provider's host template — `custom` needs an explicit host, so the
    // failure surfaces as a validation error instead of mail going nowhere.
    expect(relayProvider("mailtrap-someday").id).toBe("custom");
    expect(relayProvider(undefined).id).toBe("custom");
    expect(relayProvider("custom").hostTemplate).toBeUndefined();
  });

  test("`custom` is the last entry — the fallback depends on it", () => {
    expect(RELAY_PROVIDERS[RELAY_PROVIDERS.length - 1].id).toBe("custom");
  });

  test("every provider offers a STARTTLS submission port", () => {
    // Selected-scope relaying rejects :465 (implicit TLS is global-only), so a
    // provider whose default is 465 would be unusable for a single mailbox.
    for (const p of RELAY_PROVIDERS) expect(p.defaultPort).not.toBe(465);
  });
});

describe("isRelayProviderId", () => {
  test("accepts known ids only", () => {
    expect(isRelayProviderId("ses")).toBe(true);
    expect(isRelayProviderId("custom")).toBe(true);
    expect(isRelayProviderId("gmail")).toBe(false); // a UI/IMAP preset, not a relay
    expect(isRelayProviderId(undefined)).toBe(false);
    expect(isRelayProviderId(7)).toBe(false);
  });
});

describe("resolveRelayHost", () => {
  test("derives regional hosts from the region", () => {
    expect(resolveRelayHost({ provider: "ses", region: "eu-west-1" })).toBe("email-smtp.eu-west-1.amazonaws.com");
    expect(resolveRelayHost({ provider: "oracle", region: "us-ashburn-1" })).toBe(
      "smtp.email.us-ashburn-1.oci.oraclecloud.com",
    );
  });

  test("a regional provider ignores an explicit host — the region is the input", () => {
    // Otherwise a stale host left in the form would silently win over the region
    // the operator just changed.
    expect(resolveRelayHost({ provider: "ses", region: "us-east-2", host: "email-smtp.us-east-1.amazonaws.com" })).toBe(
      "email-smtp.us-east-2.amazonaws.com",
    );
  });

  test("a regional provider with no region can't resolve", () => {
    expect(resolveRelayHost({ provider: "ses" })).toBeNull();
    expect(resolveRelayHost({ provider: "ses", region: "   " })).toBeNull();
  });

  test("fixed-host providers use their template, overridable by the operator", () => {
    expect(resolveRelayHost({ provider: "sendgrid" })).toBe("smtp.sendgrid.net");
    // Mailgun's EU endpoint, a provider's alternate host, …
    expect(resolveRelayHost({ provider: "mailgun", host: "smtp.eu.mailgun.org" })).toBe("smtp.eu.mailgun.org");
  });

  test("custom needs a host and returns null without one", () => {
    expect(resolveRelayHost({ provider: "custom", host: " relay.acme.net " })).toBe("relay.acme.net");
    expect(resolveRelayHost({ provider: "custom" })).toBeNull();
  });
});

describe("relayProviderSpfInclude", () => {
  test("operator override wins over the registry token", () => {
    expect(relayProviderSpfInclude({ provider: "ses" })).toBe("include:amazonses.com");
    expect(relayProviderSpfInclude({ provider: "ses", spfInclude: "include:mine.example" })).toBe(
      "include:mine.example",
    );
    expect(relayProviderSpfInclude({ provider: "ses", spfInclude: "   " })).toBe("include:amazonses.com");
  });

  test("providers whose token is account/region-specific publish nothing by default", () => {
    // A guessed include goes green in the DNS check against a mechanism the
    // provider doesn't honor — see the module header.
    expect(relayProviderSpfInclude({ provider: "resend" })).toBeUndefined();
    expect(relayProviderSpfInclude({ provider: "oracle" })).toBeUndefined();
    expect(relayProviderSpfInclude({ provider: "custom" })).toBeUndefined();
    expect(relayProviderSpfInclude({ provider: "resend", spfInclude: "include:_spf.acct.resend.com" })).toBe(
      "include:_spf.acct.resend.com",
    );
  });
});

describe("relayMailFromRecords", () => {
  test("SES returns the regional feedback MX + its SPF", () => {
    expect(relayMailFromRecords({ provider: "ses", region: "us-east-1", mailFromDomain: "bounce.example.com" })).toEqual(
      { mx: "feedback-smtp.us-east-1.amazonaws.com", spf: "v=spf1 include:amazonses.com ~all" },
    );
  });

  test("null without a MAIL FROM domain, an unsupported provider, or a missing region", () => {
    expect(relayMailFromRecords({ provider: "ses", region: "us-east-1" })).toBeNull();
    expect(relayMailFromRecords({ provider: "sendgrid", mailFromDomain: "bounce.example.com" })).toBeNull();
    expect(relayMailFromRecords({ provider: "custom", mailFromDomain: "bounce.example.com" })).toBeNull();
    expect(relayMailFromRecords({ provider: "ses", mailFromDomain: "bounce.example.com" })).toBeNull();
  });
});
