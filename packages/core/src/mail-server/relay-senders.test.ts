import { describe, expect, test } from "vitest";

import {
  hasRelaySelection,
  implicitTlsUnsupported,
  isSenderAddress,
  normalizeSenderAddress,
  relayedDomainsFor,
  relaySenderKeys,
} from "./relay-senders";

describe("isSenderAddress", () => {
  test("accepts a bare mailbox", () => {
    expect(isSenderAddress("contact@example.com")).toBe(true);
    expect(isSenderAddress(" Contact@Example.COM ")).toBe(true);
    expect(isSenderAddress("first.last+tag@sub.example.co.uk")).toBe(true);
  });

  test("rejects anything that isn't a map key", () => {
    // These become `sender_relayhost` keys and Postfix map lookups — a display
    // name or a second '@' would either never match or match the wrong sender.
    expect(isSenderAddress("Contact <c@example.com>")).toBe(false);
    expect(isSenderAddress("c@@example.com")).toBe(false);
    expect(isSenderAddress("example.com")).toBe(false);
    expect(isSenderAddress("@example.com")).toBe(false);
    expect(isSenderAddress("c@example.com b@example.com")).toBe(false);
    expect(isSenderAddress("")).toBe(false);
  });
});

describe("normalizeSenderAddress", () => {
  test("trims + case-folds, because map keys are case-folded", () => {
    expect(normalizeSenderAddress("  Contact@Example.COM ")).toBe("contact@example.com");
  });
});

describe("relaySenderKeys", () => {
  test("emits bare addresses then @domain rows, deduped + case-folded", () => {
    expect(relaySenderKeys({ domains: ["X.com", "x.com"], addresses: ["Contact@Y.com ", "contact@y.com"] })).toEqual([
      "contact@y.com",
      "@x.com",
    ]);
  });

  test("an address and its own domain coexist — the map takes the specific one first", () => {
    expect(relaySenderKeys({ domains: ["example.com"], addresses: ["contact@example.com"] })).toEqual([
      "contact@example.com",
      "@example.com",
    ]);
  });

  test("empty selection has no keys", () => {
    expect(relaySenderKeys({})).toEqual([]);
    expect(hasRelaySelection({})).toBe(false);
    expect(hasRelaySelection({ domains: [], addresses: [] })).toBe(false);
    expect(hasRelaySelection({ addresses: ["contact@example.com"] })).toBe(true);
  });
});

describe("relayedDomainsFor", () => {
  test("folds in the domain of every relayed address", () => {
    // Relaying only contact@y.com still needs y.com's SPF to authorize the
    // provider, or the provider's own hostname fails SPF on that mail.
    expect(relayedDomainsFor({ domains: ["x.com"], addresses: ["Contact@Y.com"] })).toEqual(["x.com", "y.com"]);
  });

  test("no duplicate when the address's domain is already selected", () => {
    expect(relayedDomainsFor({ domains: ["x.com"], addresses: ["contact@x.com"] })).toEqual(["x.com"]);
  });

  test("ignores an address with no domain part", () => {
    expect(relayedDomainsFor({ addresses: ["@x.com"] })).toEqual([]);
  });
});

describe("implicitTlsUnsupported", () => {
  test("blocks :465 only when the relay is scoped to some senders", () => {
    // smtp_tls_wrappermode is global: on with a live direct path, Postfix would
    // speak TLS-on-connect to every port-25 MX and kill un-relayed delivery.
    expect(implicitTlsUnsupported({ scope: "selected", port: 465 })).toBe(true);
    expect(implicitTlsUnsupported({ scope: "selected", port: 587 })).toBe(false);
    expect(implicitTlsUnsupported({ scope: "all", port: 465 })).toBe(false);
    expect(implicitTlsUnsupported({ port: 465 })).toBe(false);
  });
});
