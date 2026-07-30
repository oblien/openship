/**
 * Structural tests for the credential chain TABLE (not its resolution — that's
 * tokenFor.test.ts). These assert the properties the table exists to make
 * checkable, so a future credential kind can't quietly violate them.
 */
import { describe, it, expect } from "vitest";
import { CHAINS, SPECS } from "../../../src/modules/github/github.token";

describe("credential chain — structural invariants", () => {
  it("every remote chain contains only shippable credentials", () => {
    for (const [platform, byPurpose] of Object.entries(CHAINS)) {
      for (const kind of byPurpose.remote) {
        expect(
          SPECS[kind].shippable,
          `${platform}/remote must not include non-shippable "${kind}"`,
        ).toBe(true);
      }
    }
  });

  it("gh-cli is absent from every remote chain", () => {
    for (const byPurpose of Object.values(CHAINS)) {
      expect(byPurpose.remote).not.toContain("gh-cli");
    }
  });

  it("the SaaS never offers gh-cli for any purpose", () => {
    // A multi-tenant host must never shell out to another user's gh identity.
    expect(CHAINS.saas.local).not.toContain("gh-cli");
    expect(CHAINS.saas.remote).not.toContain("gh-cli");
  });

  it("every kind named in a chain has a spec, and every spec's kind is self-consistent", () => {
    for (const byPurpose of Object.values(CHAINS)) {
      for (const kind of [...byPurpose.local, ...byPurpose.remote]) {
        expect(SPECS[kind], `no spec for "${kind}"`).toBeDefined();
        expect(SPECS[kind].kind).toBe(kind);
      }
    }
  });

  it("self-hosted local prefers auto-resolved credentials over pasted PATs", () => {
    const chain = CHAINS.selfhosted.local;
    expect(chain.indexOf("gh-cli")).toBeLessThan(chain.indexOf("project"));
    expect(chain.indexOf("app-installation")).toBeLessThan(chain.indexOf("user-pat"));
  });

  it("self-hosted remote does not fall through to user OAuth", () => {
    expect(CHAINS.selfhosted.remote).not.toContain("user-oauth");
  });
});
