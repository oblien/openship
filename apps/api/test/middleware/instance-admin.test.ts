/**
 * Instance-level authorization — the gate for whole-instance operations.
 *
 * Regression suite for GHSA-rwq6-r63g-3c8h. The bug was not "five routes forgot
 * requireRole('owner')" — it was that an ORG-scoped role check can never gate an
 * instance-wide operation:
 *
 *   - `permission.assert` resolves the org for an org-singleton tag from
 *     `resolveRequestScopeOrg`, which reads `X-Organization-Id` FIRST, and
 *     stashes it as `scopedOrganizationId`.
 *   - `requireRole` reads that stash first and unconditionally.
 *   - Every user is `owner` of an auto-provisioned personal org `org_<userId>`,
 *     which is also their default active org.
 *
 * So `requireRole("owner")` passed for ANY authenticated user. These tests lock
 * in that the replacement gate is immune to all three of those inputs, and that
 * it still admits the principals that legitimately operate an instance.
 *
 * Before this suite there was ZERO test coverage for requireRole or the
 * settings:admin tag anywhere in apps/api — which is how a decorative gate
 * survived review.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Context } from "hono";

const h = vi.hoisted(() => ({
  /** userId -> instance role, or absent for "no such user row". */
  users: {} as Record<string, string>,
  /** `${orgId}:${userId}` -> org member role. */
  members: {} as Record<string, string>,
}));

vi.mock("@repo/db", () => ({
  schema: { user: { id: "user.id", role: "user.role" } },
  // The middleware only needs eq() to carry the compared value through so the
  // fake query builder can resolve the right row.
  eq: (_col: unknown, value: unknown) => ({ value }),
  db: {
    select: () => ({
      from: () => ({
        where: (cond: { value?: string }) => ({
          limit: async () => {
            const role = cond?.value ? h.users[cond.value] : undefined;
            return role === undefined ? [] : [{ role }];
          },
        }),
      }),
    }),
  },
  repos: {
    member: {
      find: async (orgId: string, userId: string) => {
        const role = h.members[`${orgId}:${userId}`];
        return role === undefined ? undefined : { role };
      },
    },
  },
}));

const { requireInstanceAdmin, assertInstanceAdmin } = await import(
  "@/middleware/instance-admin"
);
const { requireRole } = await import("@/middleware/active-organization");

type Reply = { body: { code?: string; error?: string }; status: number };

/**
 * Context stand-in. `vars` models what authMiddleware/permission.assert put on
 * the Hono context — including the `scopedOrganizationId` stash and
 * `activeOrganizationId`, so a test can prove the gate ignores them.
 */
function fakeCtx(opts: {
  ctx?: Record<string, unknown> | null;
  header?: string;
  vars?: Record<string, unknown>;
}) {
  const vars: Record<string, unknown> = { ctx: opts.ctx ?? undefined, ...opts.vars };
  return {
    get: (k: string) => vars[k],
    set: (k: string, v: unknown) => {
      vars[k] = v;
    },
    req: {
      header: (n: string) =>
        n.toLowerCase() === "x-organization-id" ? opts.header : undefined,
      method: "POST",
    },
    json: (body: unknown, status: number) => ({ body, status }) as unknown as Response,
  } as unknown as Context;
}

const reply = (r: unknown) => r as Reply | undefined;

/** The advisory's attacker: an invited teammate. Instance role "user", but
 *  owner of their own personal org. */
const ATTACKER = "usr_attacker";
const ATTACKER_ORG = `org_${ATTACKER}`;
const OPERATOR = "usr_operator";

function principal(userId: string, extra: Record<string, unknown> = {}) {
  return { userId, organizationId: `org_${userId}`, ...extra };
}

beforeEach(() => {
  h.users = { [OPERATOR]: "admin", [ATTACKER]: "user" };
  h.members = {
    // Every user is owner of their personal org — the trust anchor.
    [`${ATTACKER_ORG}:${ATTACKER}`]: "owner",
    [`org_${OPERATOR}:${OPERATOR}`]: "owner",
    // ...and the attacker is a plain member of the operator's team org.
    [`org_team:${ATTACKER}`]: "member",
  };
});

describe("requireInstanceAdmin — the attacker from GHSA-rwq6-r63g-3c8h", () => {
  it("denies an invited teammate even though they own their personal org", async () => {
    const next = vi.fn();
    const r = reply(
      await requireInstanceAdmin()(fakeCtx({ ctx: principal(ATTACKER) }), next),
    );
    expect(r?.status).toBe(403);
    expect(r?.body.code).toBe("INSUFFICIENT_INSTANCE_ROLE");
    expect(next).not.toHaveBeenCalled();
  });

  it("denies them when they name their own org via X-Organization-Id", async () => {
    // This header is what defeated requireRole("owner").
    const next = vi.fn();
    const r = reply(
      await requireInstanceAdmin()(
        fakeCtx({ ctx: principal(ATTACKER), header: ATTACKER_ORG }),
        next,
      ),
    );
    expect(r?.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("denies them even when the permission.assert stash already names their org", async () => {
    // The decisive case: requireRole trusted this stash. The instance gate must
    // never read it.
    const next = vi.fn();
    const r = reply(
      await requireInstanceAdmin()(
        fakeCtx({
          ctx: principal(ATTACKER),
          header: ATTACKER_ORG,
          vars: {
            scopedOrganizationId: ATTACKER_ORG,
            activeOrganizationId: ATTACKER_ORG,
          },
        }),
        next,
      ),
    );
    expect(r?.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("requireInstanceAdmin — principals that must keep working", () => {
  it("admits an instance admin (founding admin / zero-auth local user)", async () => {
    const next = vi.fn();
    const r = await requireInstanceAdmin()(fakeCtx({ ctx: principal(OPERATOR) }), next);
    expect(next).toHaveBeenCalledOnce();
    expect(r).toBeUndefined();
  });

  it("admits an UNSCOPED bearer token owned by an instance admin (the CLI)", async () => {
    const next = vi.fn();
    await requireInstanceAdmin()(
      fakeCtx({ ctx: principal(OPERATOR, { sessionKind: "bearer", tokenScope: null }) }),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("requireInstanceAdmin — fails closed", () => {
  it("denies a SCOPED token even when its owner is an instance admin", async () => {
    const next = vi.fn();
    const r = reply(
      await requireInstanceAdmin()(
        fakeCtx({
          ctx: principal(OPERATOR, {
            sessionKind: "bearer",
            tokenScope: { tokenId: "pat_1" },
          }),
        }),
        next,
      ),
    );
    expect(r?.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s when the route forgot authMiddleware (no RequestContext)", async () => {
    const next = vi.fn();
    const r = reply(await requireInstanceAdmin()(fakeCtx({ ctx: null }), next));
    expect(r?.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("denies when the user row is gone", async () => {
    const next = vi.fn();
    const r = reply(
      await requireInstanceAdmin()(fakeCtx({ ctx: principal("usr_deleted") }), next),
    );
    expect(r?.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("assertInstanceAdmin — controller-level defense in depth", () => {
  it("throws 403 for the attacker", async () => {
    await expect(
      assertInstanceAdmin(principal(ATTACKER) as never),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("resolves for an instance admin", async () => {
    await expect(
      assertInstanceAdmin(principal(OPERATOR) as never),
    ).resolves.toBeUndefined();
  });
});

describe("requireRole no longer fails open for the 'restricted' role", () => {
  // RANK = { member, admin, owner } has no `restricted` key, so RANK[role] was
  // undefined and `undefined < RANK[min]` evaluated FALSE — requireRole passed
  // for exactly the least-trusted role.
  it("denies a restricted member where it used to pass", async () => {
    h.members["org_team:usr_restricted"] = "restricted";
    const next = vi.fn();
    const r = reply(
      await requireRole("owner")(
        fakeCtx({
          ctx: { userId: "usr_restricted", organizationId: "org_team" },
          vars: { activeOrganizationId: "org_team" },
        }),
        next,
      ),
    );
    expect(r?.status).toBe(403);
    expect(r?.body.code).toBe("INSUFFICIENT_ROLE");
    expect(next).not.toHaveBeenCalled();
  });

  it("denies an unrecognised role value too", async () => {
    h.members["org_team:usr_weird"] = "banana";
    const next = vi.fn();
    const r = reply(
      await requireRole("member")(
        fakeCtx({
          ctx: { userId: "usr_weird", organizationId: "org_team" },
          vars: { activeOrganizationId: "org_team" },
        }),
        next,
      ),
    );
    expect(r?.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("still admits a genuine owner", async () => {
    const next = vi.fn();
    await requireRole("owner")(
      fakeCtx({
        ctx: principal(OPERATOR),
        vars: { activeOrganizationId: `org_${OPERATOR}` },
      }),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});
