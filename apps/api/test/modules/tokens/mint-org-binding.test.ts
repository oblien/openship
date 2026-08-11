import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "hono";
import type { RequestContext } from "../../../src/lib/request-context";

/**
 * A TOKEN CAN ONLY GRANT ACCESS THE MINTER ALREADY HAS — **in the org the token is
 * bound to**. GHSA-qv27-39pc-qw9f findings 1 and 2.
 *
 * Finding 1 (cross-org binding): `authorizeMcpClient` re-verified membership in
 * `body.organizationId` but then validated grant WIDTH against `ctx.organizationId`
 * — the caller's ACTIVE org — while writing the binding to the target org. So a
 * plain member of org B could mint a token bound to org B carrying permissions
 * they only hold in org A. The precondition was free: every provisioned user gets
 * an owner-role personal workspace, and the active org is caller-chosen via
 * `X-Organization-Id`. Membership in the victim org was the only real barrier.
 *
 * Scoping the ctx is only half of it: the org-singleton arm has to follow the ctx
 * too. It used to resolve `resourceId: "*"` through `resolveRequestScopeOrg` — the
 * raw header — so a caller-chosen header still supplied the authority no matter what
 * ctx said. Both halves are asserted here (see permission-scope-source.test.ts for
 * the arm itself).
 *
 * Finding 2 (owner-wide widening): `minterHasAccess` delegated a
 * `github_installation` grant to `canUseGitHubRepo` with `repo: null`, whose
 * owner-level arm passes anyone holding ANY repo under that owner. That is sound
 * where something downstream narrows it (listing, the picker, the project
 * binding); at mint time nothing does — the grant written IS the authority.
 *
 * Every case is asserted in BOTH directions: the escalation is refused, and the
 * legitimate mint it resembles still succeeds. A test that only checks the refusal
 * would also pass if the whole route started returning 403.
 */

const OWNER_ORG = "orgA"; // u1 is owner here — in practice their personal workspace
const VICTIM_ORG = "orgB"; // u1 is a plain member here

type Grant = { resourceType: string; resourceId: string; permissions: string[]; scope?: unknown };

/**
 * Hoisted so the `vi.mock` factory (which vitest lifts above every import) can
 * reach the spies and the mutable grant table.
 */
const mocks = vi.hoisted(() => ({
  /** Grants u1 holds, per org. Reassigned per test. */
  state: { grantsByOrg: {} as Record<string, Grant[]> },
  upsertOAuthBinding: vi.fn(async (args: { organizationId: string }) => ({
    id: "binding1",
    readOnly: false,
    organizationId: args.organizationId,
  })),
  // The binding + its grants are now written in ONE transaction, so the assertions
  // below read the grants off this call rather than off a separate createMany.
  upsertOAuthBindingWithGrants: vi.fn(async (args: { organizationId: string }) => ({
    id: "binding1",
    readOnly: false,
    scoped: true,
    organizationId: args.organizationId,
  })),
  // Consent looks the binding up too, for the org-rebind guard and the audit
  // before-state. Null = not yet connected, which is the consent case.
  findOAuthBinding: vi.fn(async () => null),
  createMany: vi.fn(async () => {}),
  deleteByToken: vi.fn(async () => {}),
}));

const { upsertOAuthBindingWithGrants, findOAuthBinding } = mocks;

vi.mock("@repo/db", () => ({
  repos: {
    member: {
      find: vi.fn(async (orgId: string, userId: string) => {
        if (userId !== "u1") return null;
        if (orgId === "orgA") return { id: "mA", role: "owner" };
        if (orgId === "orgB") return { id: "mB", role: "member" };
        return null;
      }),
    },
    resourceGrant: {
      listByMember: vi.fn(async (orgId: string) => mocks.state.grantsByOrg[orgId] ?? []),
      findForResource: vi.fn(async (orgId: string, _u: string, type: string, id: string) => {
        const held = mocks.state.grantsByOrg[orgId] ?? [];
        return held.find((g) => g.resourceType === type && g.resourceId === id) ?? null;
      }),
    },
    patGrant: {
      createMany: mocks.createMany,
      deleteByToken: mocks.deleteByToken,
      findForResource: vi.fn(async () => null),
      listByToken: vi.fn(async () => []),
    },
    personalAccessToken: {
      upsertOAuthBinding: mocks.upsertOAuthBinding,
      upsertOAuthBindingWithGrants: mocks.upsertOAuthBindingWithGrants,
      findOAuthBinding: mocks.findOAuthBinding,
    },
    organization: { findManyById: vi.fn(async () => []) },
    oauth: { listApplicationsByClientIds: vi.fn(async () => []) },
    // Authorizing now records an audit event. It is fire-and-forget and swallows its
    // own errors, so this only keeps the run's output clean.
    auditEvent: { create: vi.fn(async () => {}) },
    project: { findById: vi.fn(async () => null), findEnvVarById: vi.fn(async () => null) },
    server: { get: vi.fn(async () => null) },
    backupDestination: { findById: vi.fn(async () => null) },
    deployment: { findById: vi.fn(async () => null), findBuildSession: vi.fn(async () => null) },
    domain: { findById: vi.fn(async () => null) },
    service: { findById: vi.fn(async () => null) },
    backupPolicy: { findById: vi.fn(async () => null) },
    backupRun: { findById: vi.fn(async () => null) },
    backupRestore: { findById: vi.fn(async () => null) },
  },
}));
vi.mock("../../../src/config/env", () => ({ env: { CLOUD_MODE: false } }));

import { authorizeMcpClient } from "../../../src/modules/tokens/token.controller";
import { canUseGitHubRepo } from "../../../src/modules/github/github-access";

interface Reply {
  body: { data?: unknown; error?: string; code?: string };
  status: number;
}

/**
 * Minimal Hono stand-in. `activeOrg` is BOTH `ctx.organizationId` and the
 * `X-Organization-Id` header, because that is how a real request arrives — and it
 * is what made the two org resolutions look interchangeable.
 */
function requestFrom(activeOrg: string, body: unknown): { c: Context; reply: () => Reply } {
  let captured: Reply | undefined;
  const c = {
    req: {
      json: async () => body,
      header: (n: string) =>
        n.toLowerCase() === "x-organization-id" ? activeOrg : undefined,
      method: "POST",
    },
    json: (b: Reply["body"], status = 200) => {
      captured = { body: b, status };
      return captured as unknown as Response;
    },
    get: (k: string) => (k === "ctx" ? ctx : undefined),
    set: () => {},
    var: {},
  } as unknown as Context;

  const ctx = {
    userId: "u1",
    user: { id: "u1", email: "u1@example.com", name: null },
    organizationId: activeOrg,
    // The caller's role in their ACTIVE org, exactly as authMiddleware sets it.
    role: activeOrg === OWNER_ORG ? "owner" : "member",
    membershipId: activeOrg === OWNER_ORG ? "mA" : "mB",
    sessionId: "s1",
    sessionKind: "cookie",
    principalKind: null,
    tokenScope: null,
    clientIp: null,
    userAgent: null,
    traceId: "t1",
    hono: c,
  } as unknown as RequestContext;

  return {
    c,
    reply: () => {
      if (!captured) throw new Error("handler produced no response");
      return captured;
    },
  };
}

async function authorize(activeOrg: string, body: unknown): Promise<Reply> {
  const { c, reply } = requestFrom(activeOrg, body);
  await authorizeMcpClient(c);
  return reply();
}

beforeEach(() => {
  mocks.state.grantsByOrg = {};
  upsertOAuthBindingWithGrants.mockClear();
  findOAuthBinding.mockClear();
});

describe("finding 1: grant width is checked in the org the binding is written to", () => {
  /**
   * `billing` and `audit` are the two types `roleAllowsResourceType` denies a
   * member, and both are grantable — so they isolate "authority comes from the
   * caller's ROLE in an org" with no resource row involved.
   */
  const ROLE_BASED_GRANTS = [
    { resourceType: "billing", resourceId: "*", permissions: ["read"] },
    { resourceType: "audit", resourceId: "*", permissions: ["read"] },
  ];

  it("REFUSES role-based grants the caller holds only in their active org", async () => {
    const r = await authorize(OWNER_ORG, {
      clientId: "cli",
      organizationId: VICTIM_ORG,
      grants: ROLE_BASED_GRANTS,
    });

    expect(r.status).toBe(403);
    expect(r.body.code).toBe("GRANT_EXCEEDS_ACCESS");
    // Nothing may be persisted — the binding is the durable authority.
    expect(upsertOAuthBindingWithGrants).not.toHaveBeenCalled();
  });

  it("still allows the same grants when the binding targets the org they hold them in", async () => {
    const r = await authorize(OWNER_ORG, {
      clientId: "cli",
      organizationId: OWNER_ORG,
      grants: ROLE_BASED_GRANTS,
    });

    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ok: true, scoped: true });
    expect(upsertOAuthBindingWithGrants).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: OWNER_ORG }),
    );
  });

  /**
   * The header half of finding 1. `resolveInputOrg` sends `resourceId: "*"` to
   * `resolveRequestScopeOrg`, which reads `X-Organization-Id` directly — so a fix
   * that only rebinds `ctx.organizationId` would still validate against the header
   * and let this through. Here the header names the org u1 owns while the binding
   * targets the org they are merely a member of.
   */
  it("does not let the X-Organization-Id header supply the authority", async () => {
    const r = await authorize(OWNER_ORG, {
      clientId: "cli",
      organizationId: VICTIM_ORG,
      grants: [{ resourceType: "billing", resourceId: "*", permissions: ["read"] }],
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("GRANT_EXCEEDS_ACCESS");
  });

  it("REFUSES a GitHub grant, with source scope, that the caller holds nothing for in the target org", async () => {
    // u1 is owner of OWNER_ORG (⇒ full GitHub) and holds NOTHING in VICTIM_ORG.
    const r = await authorize(OWNER_ORG, {
      clientId: "some-mcp-client",
      organizationId: VICTIM_ORG,
      grants: [
        {
          resourceType: "github_repository",
          resourceId: "acme/private-infra",
          permissions: ["read"],
          scope: { v: 1, read: { paths: ["**"] } },
        },
      ],
    });

    expect(r.status).toBe(403);
    expect(r.body.code).toBe("GRANT_EXCEEDS_ACCESS");
    expect(upsertOAuthBindingWithGrants).not.toHaveBeenCalled();
  });

  it("still allows that GitHub grant when bound to the org whose owner they are", async () => {
    const r = await authorize(OWNER_ORG, {
      clientId: "some-mcp-client",
      organizationId: OWNER_ORG,
      grants: [
        {
          resourceType: "github_repository",
          resourceId: "acme/private-infra",
          permissions: ["read"],
          scope: { v: 1, read: { paths: ["**"] } },
        },
      ],
    });
    expect(r.status).toBe(200);
  });

  it("keeps rejecting a binding to an org the caller is not a member of at all", async () => {
    const r = await authorize(OWNER_ORG, {
      clientId: "cli",
      organizationId: "orgC",
      grants: [{ resourceType: "billing", resourceId: "*", permissions: ["read"] }],
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ORG_NOT_A_MEMBER");
  });
});

describe("finding 2: one repo under an owner is not authority over the owner", () => {
  /** u1's entire GitHub holding in VICTIM_ORG: a single repo. */
  const ONE_REPO: Grant = {
    resourceType: "github_repository",
    resourceId: "acme/my-app",
    permissions: ["read"],
  };

  beforeEach(() => {
    mocks.state.grantsByOrg = { [VICTIM_ORG]: [ONE_REPO] };
  });

  it("REFUSES minting an owner-wide github_installation grant from a single repo grant", async () => {
    const r = await authorize(VICTIM_ORG, {
      clientId: "cli",
      organizationId: VICTIM_ORG,
      grants: [{ resourceType: "github_installation", resourceId: "acme", permissions: ["read"] }],
    });

    expect(r.status).toBe(403);
    expect(r.body.code).toBe("GRANT_EXCEEDS_ACCESS");
    expect(upsertOAuthBindingWithGrants).not.toHaveBeenCalled();
  });

  it("still allows re-granting exactly the repo they hold", async () => {
    const r = await authorize(VICTIM_ORG, {
      clientId: "cli",
      organizationId: VICTIM_ORG,
      grants: [{ ...ONE_REPO }],
    });
    expect(r.status).toBe(200);
    expect(upsertOAuthBindingWithGrants).toHaveBeenCalled();
  });

  it("still allows an owner-wide grant when the caller actually holds the installation", async () => {
    mocks.state.grantsByOrg = {
      [VICTIM_ORG]: [
        { resourceType: "github_installation", resourceId: "acme", permissions: ["read"] },
      ],
    };
    const r = await authorize(VICTIM_ORG, {
      clientId: "cli",
      organizationId: VICTIM_ORG,
      grants: [{ resourceType: "github_installation", resourceId: "acme", permissions: ["read"] }],
    });
    expect(r.status).toBe(200);
  });

  it("does not widen to a different owner either", async () => {
    const r = await authorize(VICTIM_ORG, {
      clientId: "cli",
      organizationId: VICTIM_ORG,
      grants: [
        { resourceType: "github_installation", resourceId: "otherowner", permissions: ["read"] },
      ],
    });
    expect(r.status).toBe(403);
  });

  /**
   * The reason this is an opt-in mode rather than a blanket tightening: the
   * owner-level probe is what keeps a repo-only member's picker and list endpoints
   * working. Tightening it everywhere would have broken them silently.
   */
  it("leaves the default owner-level reach intact for listing/picker gating", async () => {
    const ctx = {
      userId: "u1",
      organizationId: VICTIM_ORG,
      tokenScope: null,
    } as unknown as RequestContext;

    // Default ("reach"): a repo grant under acme still answers the owner-level question.
    await expect(canUseGitHubRepo(ctx, { owner: "acme", repo: null }, "read")).resolves.toBe(true);
    // Explicit "authority": the same holding is not enough.
    await expect(
      canUseGitHubRepo(ctx, { owner: "acme", repo: null }, "read", { ownerLevel: "authority" }),
    ).resolves.toBe(false);
    // Neither mode changes the exact-repo answer.
    await expect(
      canUseGitHubRepo(ctx, { owner: "acme", repo: "my-app" }, "read", {
        ownerLevel: "authority",
      }),
    ).resolves.toBe(true);
    await expect(
      canUseGitHubRepo(ctx, { owner: "acme", repo: "secret-payments" }, "read"),
    ).resolves.toBe(false);
  });
});
