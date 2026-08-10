/**
 * Bearer org confinement — the gate that keeps X-Organization-Id from being a
 * trust input for a scoped token.
 *
 * Why this matters more than it looks: a scoped token's grants are looked up by
 * TOKEN ID with the (org, user) arguments discarded (lib/grant-source.ts), and
 * wildcard/list-scope checks take their org from X-Organization-Id
 * (permission.ts → resolveRequestScopeOrg). For a CONCRETE resource id that's
 * harmless — the grant names one resource, which lives in exactly one org, and
 * `resolveInputOrg` resolves that resource's own org. But at resourceId "*" the
 * header alone selects which org the token's capabilities apply in, gated only by
 * membership. Now that an org-singleton "*" grant actually authorizes something,
 * that had to fail closed.
 *
 * These lock in: a scoped principal MUST be org-bound, and a bound one can only
 * ever act in its bound org.
 */

import { describe, it, expect } from "vitest";
import type { Context } from "hono";
import { enforceBoundOrgAndReadOnly } from "@/middleware/auth";

/** Minimal Context stand-in: the gate reads one header + the method, and calls json(). */
function fakeCtx(opts: { header?: string; method?: string }) {
  return {
    req: {
      header: (n: string) =>
        n.toLowerCase() === "x-organization-id" ? opts.header : undefined,
      method: opts.method ?? "GET",
    },
    json: (body: unknown, status: number) => ({ body, status }) as unknown as Response,
  } as unknown as Context;
}

const base = {
  orgScopeMessage: "scoped to a different organization",
  readOnlyMessage: "read-only",
};

const result = (r: Response | null) => r as unknown as { body: { code: string }; status: number } | null;

describe("scoped principal must be org-bound (fail closed)", () => {
  it("rejects a scoped token with no bound org", () => {
    const r = result(
      enforceBoundOrgAndReadOnly(fakeCtx({ header: "org-anything" }), {
        boundOrg: null,
        readOnly: false,
        scoped: true,
        ...base,
      }),
    );
    expect(r?.status).toBe(403);
    expect(r?.body.code).toBe("TOKEN_ORG_UNBOUND");
  });

  it("rejects it even when NO org header is sent — the token itself is the problem", () => {
    const r = result(
      enforceBoundOrgAndReadOnly(fakeCtx({}), {
        boundOrg: null,
        readOnly: false,
        scoped: true,
        ...base,
      }),
    );
    expect(r?.body.code).toBe("TOKEN_ORG_UNBOUND");
  });

  it("allows an UNSCOPED token with no bound org — it acts with the user's own role", () => {
    // No grant lookup to mis-scope: an unscoped bearer is evaluated by
    // roleAllowsResourceType against its membership in whichever org it names.
    expect(
      enforceBoundOrgAndReadOnly(fakeCtx({ header: "org2" }), {
        boundOrg: null,
        readOnly: false,
        scoped: false,
        ...base,
      }),
    ).toBeNull();
  });
});

describe("a bound token can only act in its bound org", () => {
  it("rejects a mismatched X-Organization-Id", () => {
    const r = result(
      enforceBoundOrgAndReadOnly(fakeCtx({ header: "org2" }), {
        boundOrg: "org1",
        readOnly: false,
        scoped: true,
        ...base,
      }),
    );
    expect(r?.status).toBe(403);
    expect(r?.body.code).toBe("TOKEN_ORG_SCOPE");
  });

  it("allows a matching header", () => {
    expect(
      enforceBoundOrgAndReadOnly(fakeCtx({ header: "org1" }), {
        boundOrg: "org1",
        readOnly: false,
        scoped: true,
        ...base,
      }),
    ).toBeNull();
  });

  it("allows an absent header — the bound org is the default, not the header", () => {
    expect(
      enforceBoundOrgAndReadOnly(fakeCtx({}), {
        boundOrg: "org1",
        readOnly: false,
        scoped: true,
        ...base,
      }),
    ).toBeNull();
  });
});

describe("read-only is a blunt method gate, before any permission check", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("rejects %s", (method) => {
    const r = result(
      enforceBoundOrgAndReadOnly(fakeCtx({ header: "org1", method }), {
        boundOrg: "org1",
        readOnly: true,
        scoped: true,
        ...base,
      }),
    );
    expect(r?.status).toBe(403);
    expect(r?.body.code).toBe("TOKEN_READ_ONLY");
  });

  it("allows GET", () => {
    expect(
      enforceBoundOrgAndReadOnly(fakeCtx({ header: "org1", method: "GET" }), {
        boundOrg: "org1",
        readOnly: true,
        scoped: true,
        ...base,
      }),
    ).toBeNull();
  });

  it("org confinement is checked BEFORE read-only — the more specific failure wins", () => {
    const r = result(
      enforceBoundOrgAndReadOnly(fakeCtx({ header: "org2", method: "POST" }), {
        boundOrg: "org1",
        readOnly: true,
        scoped: true,
        ...base,
      }),
    );
    expect(r?.body.code).toBe("TOKEN_ORG_SCOPE");
  });
});
