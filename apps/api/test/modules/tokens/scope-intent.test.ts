import { describe, expect, it } from "vitest";

import { resolveScopeIntent } from "../../../src/modules/tokens/token.controller";

/**
 * The scoped-vs-unscoped decision, which both mint paths (PAT create + MCP
 * OAuth authorize) share.
 *
 * This exists because the rule used to be `scoped = grants.length > 0`, so an
 * empty grant list minted an UNSCOPED principal acting with the minter's own
 * role. That made two opposite intents identical on the wire — and it failed
 * OPEN for the dangerous one, since a caller that meant to restrict a token but
 * produced no usable grants received full access. The only thing between that
 * and a live token was a client-side guard on the consent screen.
 *
 * The direction that matters: absence of grants must NEVER widen access.
 */
describe("resolveScopeIntent", () => {
  it("grants present → scoped", () => {
    expect(resolveScopeIntent({ hasGrants: true })).toEqual({ scoped: true });
  });

  it("no grants + explicit fullAccess → unscoped", () => {
    expect(resolveScopeIntent({ hasGrants: false, fullAccess: true })).toEqual({ scoped: false });
  });

  it("REFUSES no grants with no stated intent — the old silent-full-access path", () => {
    const r = resolveScopeIntent({ hasGrants: false });
    expect(r).toHaveProperty("error");
    if (!("error" in r)) throw new Error("expected an error");
    expect(r.error.status).toBe(400);
    expect(r.error.body.code).toBe("TOKEN_SCOPE_REQUIRED");
  });

  it("REFUSES both at once rather than guessing which half to honour", () => {
    const r = resolveScopeIntent({ hasGrants: true, fullAccess: true });
    expect(r).toHaveProperty("error");
    if (!("error" in r)) throw new Error("expected an error");
    expect(r.error.status).toBe(400);
    expect(r.error.body.code).toBe("AMBIGUOUS_TOKEN_SCOPE");
  });

  /**
   * `fullAccess` must be the literal `true`, not merely truthy-ish. A JSON body
   * carrying `"true"`, `1`, or `{}` is a malformed request, and coercing it would
   * reintroduce exactly the fail-open this function removed.
   */
  it("treats a non-true fullAccess as absent, never as consent", () => {
    for (const bad of [false, undefined, null, 0, 1, "true", "", {}, []]) {
      const r = resolveScopeIntent({
        hasGrants: false,
        fullAccess: bad as unknown as boolean | undefined,
      });
      expect(r, `fullAccess=${JSON.stringify(bad)} must not mint an unscoped token`).toHaveProperty(
        "error",
      );
    }
  });

  it("a non-true fullAccess alongside grants is not ambiguous — it just scopes", () => {
    expect(
      resolveScopeIntent({ hasGrants: true, fullAccess: false as unknown as boolean }),
    ).toEqual({ scoped: true });
  });
});
