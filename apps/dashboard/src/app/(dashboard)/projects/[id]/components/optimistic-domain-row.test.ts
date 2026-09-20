import { describe, expect, it } from "vitest";

import { buildOptimisticDomainRow, findLoadedDomainRow } from "./optimistic-domain-row";

/**
 * The invariant: an optimistic row may be optimistic about everything EXCEPT its
 * id. `canVerify = needsVerify && !!domainId` treats that id as proof the server
 * row exists, so an invented one renders a live Verify button that POSTs
 * `/domains/<invented>/verify` and 404s — and a DNS-records panel whose failure
 * used to read as the reassuring "No records to add for this domain."
 */
describe("buildOptimisticDomainRow", () => {
  const custom = { domainType: "custom", customDomain: "api.example.com", port: 4010 };
  const free = { domainType: "free", domain: "my-app", port: 3000 };

  it("carries NO id for a hostname that has no loaded row", () => {
    const row = buildOptimisticDomainRow({
      endpoint: custom,
      hostname: "api.example.com",
      existing: undefined,
      index: 0,
    });
    expect(row.id).toBeUndefined();
  });

  it("never falls back to the hostname as an id", () => {
    const row = buildOptimisticDomainRow({
      endpoint: custom,
      hostname: "api.example.com",
      existing: undefined,
      index: 0,
    });
    expect(row.id).not.toBe("api.example.com");
  });

  it("keeps the real row id when one was loaded", () => {
    const row = buildOptimisticDomainRow({
      endpoint: custom,
      hostname: "api.example.com",
      existing: { id: "dom_abc", hostname: "api.example.com", verified: true },
      index: 0,
    });
    expect(row.id).toBe("dom_abc");
  });

  it("refuses a non-string id even when a row was matched", () => {
    const row = buildOptimisticDomainRow({
      endpoint: custom,
      hostname: "api.example.com",
      existing: { id: 42, hostname: "api.example.com" },
      index: 0,
    });
    expect(row.id).toBeUndefined();
  });

  it("does not flash a brand-new custom domain as verified", () => {
    const row = buildOptimisticDomainRow({
      endpoint: custom,
      hostname: "api.example.com",
      existing: undefined,
      index: 0,
    });
    expect(row.verified).toBe(false);
    expect(row.status).toBe("pending");
    expect(row.sslStatus).toBe("none");
  });

  it("treats a free managed host as verified and covered immediately", () => {
    const row = buildOptimisticDomainRow({
      endpoint: free,
      hostname: "my-app.opsh.io",
      existing: undefined,
      index: 0,
    });
    expect(row.verified).toBe(true);
    expect(row.status).toBe("active");
    expect(row.sslStatus).toBe("active");
  });

  it("preserves a loaded row's real verify/SSL state instead of guessing", () => {
    const row = buildOptimisticDomainRow({
      endpoint: custom,
      hostname: "api.example.com",
      existing: {
        id: "dom_abc",
        hostname: "api.example.com",
        verified: true,
        status: "active",
        sslStatus: "active",
      },
      index: 1,
    });
    expect(row.verified).toBe(true);
    expect(row.sslStatus).toBe("active");
    // Order is the source of truth for primary, so it is NOT inherited.
    expect(row.isPrimary).toBe(false);
    expect(row.primary).toBe(false);
  });

  it("makes the first endpoint primary regardless of the loaded row", () => {
    const row = buildOptimisticDomainRow({
      endpoint: custom,
      hostname: "api.example.com",
      existing: { id: "dom_abc", hostname: "api.example.com", isPrimary: false },
      index: 0,
    });
    expect(row.isPrimary).toBe(true);
  });
});

describe("findLoadedDomainRow", () => {
  const rows = [
    { id: "dom_1", hostname: "api.example.com" },
    { id: "dom_2", hostname: "app.example.com" },
  ];

  it("matches by hostname", () => {
    expect(findLoadedDomainRow(rows, "app.example.com")?.id).toBe("dom_2");
  });

  it("matches by the draft's id, which an endpoint loaded from /info carries", () => {
    expect(findLoadedDomainRow(rows, "renamed.example.com", "dom_1")?.id).toBe("dom_1");
  });

  it("returns nothing for a hostname this project has no row for", () => {
    expect(findLoadedDomainRow(rows, "new.example.com")).toBeUndefined();
  });

  it("never matches on an absent draft id", () => {
    // Both a row id and the draft id being undefined must not compare equal —
    // that would hand an unrelated row's id to a brand-new hostname.
    expect(findLoadedDomainRow([{ hostname: "a.example.com" }], "new.example.com", undefined))
      .toBeUndefined();
  });

  it("tolerates a missing list", () => {
    expect(findLoadedDomainRow(undefined, "api.example.com")).toBeUndefined();
  });
});

