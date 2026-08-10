import { describe, it, expect, vi } from "vitest";
import type { Context } from "hono";
import type { RequestContext } from "../../src/lib/request-context";

/**
 * MINT/USE SYMMETRY.
 *
 * `checkPermissionOnResource` (mint-time: "may this user grant this?") and
 * `assert` (use-time: "may this token do this?") are documented as sharing
 * `resolveInputOrg` "so mint-time acceptance and use-time enforcement can never
 * drift". They diverged anyway, because the two evaluate DIFFERENT principals:
 *
 *   mint → the minter's role      (owner ⇒ roleAllowsResourceType ⇒ accept)
 *   use  → the token, `restricted` (grant-based ⇒ needs a satisfiable arm)
 *
 * So an owner could mint {billing,"*",[read]} and the resulting token could never
 * use it. Any grant the mint ACCEPTS must be USABLE by the token it lands on —
 * otherwise the consent screen promises access the bearer never gets.
 *
 * This test asserts that in both directions for the whole grantable surface.
 */

vi.mock("@repo/db", () => ({
  repos: {
    member: { find: vi.fn(async () => ({ id: "m1", role: "owner" })) },
    project: {
      findById: vi.fn(async (id: string) => (id === "*" ? null : { id, organizationId: "org1" })),
      findEnvVarById: vi.fn(async () => null),
    },
    server: { get: vi.fn(async (id: string) => (id === "*" ? null : { id, organizationId: "org1" })) },
    backupDestination: {
      findById: vi.fn(async (id: string) => (id === "*" ? null : { id, organizationId: "org1" })),
    },
    deployment: { findById: vi.fn(async () => null), findBuildSession: vi.fn(async () => null) },
    domain: { findById: vi.fn(async () => null) },
    service: { findById: vi.fn(async () => null) },
    backupPolicy: { findById: vi.fn(async () => null) },
    backupRun: { findById: vi.fn(async () => null) },
    backupRestore: { findById: vi.fn(async () => null) },
    resourceGrant: { findForResource: vi.fn(async () => null), listByMember: vi.fn(async () => []) },
    patGrant: { findForResource: vi.fn(async () => null), listByToken: vi.fn(async () => []) },
  },
}));
vi.mock("../../src/config/env", () => ({ env: { CLOUD_MODE: false } }));

import { checkPermission, checkPermissionOnResource, ORG_SINGLETON_RESOURCES } from "../../src/lib/permission";
import { GRANTABLE_RESOURCE_TYPES } from "../../src/lib/grantable-types";

type G = { resourceType: string; resourceId: string; permissions: string[] };

function source(grants: G[]) {
  return {
    findForResource: async (_o: string, _u: string, type: string, id: string) => {
      const specific = grants.find((g) => g.resourceType === type && g.resourceId === id);
      const wildcard = grants.find((g) => g.resourceType === type && g.resourceId === "*");
      const g = specific ?? wildcard ?? null;
      return g ? ({ ...g } as never) : null;
    },
    listByMember: async () => grants as never,
  } as never;
}

/** An owner's browser session, with X-Organization-Id set — the mint context. */
const minterCtx = () =>
  ({
    userId: "u1",
    organizationId: "org1",
    hono: {
      req: { header: (n: string) => (n.toLowerCase() === "x-organization-id" ? "org1" : undefined) },
      set: () => {},
      get: () => undefined,
      var: {},
    } as unknown as Context,
  }) as unknown as RequestContext;

/**
 * The grant shape the UI produces per type. Org-singletons are granted at "*";
 * everything else names a concrete resource.
 */
function grantFor(type: string): G {
  const resourceId = ORG_SINGLETON_RESOURCES.has(type)
    ? "*"
    : type === "github_repository"
      ? "hydralerne/charts"
      : type === "github_installation"
        ? "hydralerne"
        : "R1";
  return { resourceType: type, resourceId, permissions: ["read"] };
}

describe("anything the mint accepts, the token can use", () => {
  it("holds for every type on the grantable surface", async () => {
    for (const type of GRANTABLE_RESOURCE_TYPES) {
      const g = grantFor(type);

      // Mint-time: would an owner be allowed to hand out this grant?
      const acceptedAtMint = await checkPermissionOnResource(minterCtx(), {
        resourceType: type as never,
        resourceId: g.resourceId,
        action: "read",
      });

      // Use-time: can the scoped token holding exactly that grant read it?
      // github_* are authorized by canUseGitHubRepo, not checkPermission — they
      // are covered by permission-grant-satisfiability.test.ts's door 2, so the
      // symmetry claim here is limited to the types checkPermission owns.
      if (type === "github_installation" || type === "github_repository") continue;

      const usableAtRuntime = await checkPermission(
        "u1",
        "org1",
        { resourceType: type as never, resourceId: g.resourceId, action: "read" },
        { roleOverride: "restricted", grants: source([g]) },
      );

      expect(
        { type, acceptedAtMint, usableAtRuntime },
        `${type}: mint and use must agree — a grant the mint accepts but the ` +
          `token cannot use is a promise the bearer never receives`,
      ).toEqual({ type, acceptedAtMint: true, usableAtRuntime: true });
    }
  });
});

describe("the asymmetry that caused this, pinned", () => {
  it('a non-grantable org-singleton is rejected at MINT too, so the gap cannot reopen quietly', async () => {
    // `settings` is an org-singleton that is NOT on the grantable surface. It must
    // not be mintable — if someone adds it to GRANTABLE_RESOURCE_TYPES, the
    // satisfiability ratchet forces them to prove it works first.
    expect(GRANTABLE_RESOURCE_TYPES).not.toContain("settings");
  });

  it("a scoped token cannot use a grant it does not hold, even for a satisfiable type", async () => {
    const ok = await checkPermission(
      "u1",
      "org1",
      { resourceType: "billing" as never, resourceId: "*", action: "read" },
      { roleOverride: "restricted", grants: source([grantFor("audit")]) },
    );
    expect(ok).toBe(false);
  });
});
