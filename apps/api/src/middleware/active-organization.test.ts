import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The resolver that decides which tenant a request is scoped to.
 *
 * It had no tests, which is the wrong shape for the one function in the codebase that is
 * ALLOWED to guess an organization. Everywhere else reads `ctx.organizationId`; this is
 * where that value comes from, so its two properties are worth pinning permanently:
 *
 * 1. **It can only ever return an org the user is a member of.** Every candidate is drawn
 *    from `memberOrgIds`, so the blast radius of a wrong guess is "scoped to the wrong org
 *    you already belong to" and never a cross-tenant read. A stale
 *    `session.activeOrganizationId` — the user was removed from that org after the session
 *    was issued — must fall through rather than be trusted.
 * 2. **It is deterministic.** Two API nodes resolving the same user must agree, or the
 *    active org flickers between requests.
 */

const h = vi.hoisted(() => ({
  members: [] as Array<{ organizationId: string; createdAt: Date | null }>,
  orgs: [] as Array<{ id: string; isTeam: boolean } | null>,
  /** Set to an Error to make the corresponding repo call reject. */
  membersError: null as Error | null,
  orgsError: null as Error | null,
}));

vi.mock("@repo/db", () => ({
  repos: {
    member: {
      listByUser: async () => {
        if (h.membersError) throw h.membersError;
        // The real repo orders by createdAt; the resolver must not depend on more than
        // that, so this returns rows in the order the fixture declares them.
        return h.members;
      },
    },
    organization: {
      findManyById: async () => {
        if (h.orgsError) throw h.orgsError;
        return h.orgs;
      },
    },
  },
}));

import { resolveActiveOrganizationId } from "./active-organization";

const at = (iso: string) => new Date(iso);

beforeEach(() => {
  h.members = [];
  h.orgs = [];
  h.membersError = null;
  h.orgsError = null;
});

/** Declare memberships plus which of those orgs are team orgs. */
function host(
  members: Array<{ organizationId: string; createdAt: Date | null }>,
  teamOrgIds: string[] = [],
) {
  h.members = members;
  h.orgs = members.map((m) => ({
    id: m.organizationId,
    isTeam: teamOrgIds.includes(m.organizationId),
  }));
}

describe("resolveActiveOrganizationId", () => {
  it("honours a session org the user is still a member of", async () => {
    host([
      { organizationId: "org_a", createdAt: at("2026-01-01") },
      { organizationId: "org_b", createdAt: at("2026-01-02") },
    ]);

    expect(await resolveActiveOrganizationId("u1", "org_b")).toBe("org_b");
  });

  it("falls through a session org the user has since been removed from", async () => {
    // The security property: a session outlives a membership. Trusting the pointer here
    // would scope the request to an org this user can no longer see.
    host([{ organizationId: "org_a", createdAt: at("2026-01-01") }]);

    expect(await resolveActiveOrganizationId("u1", "org_gone")).toBe("org_a");
  });

  it("never returns an org outside the user's memberships", async () => {
    // `findManyById` answering with rows the membership set does not contain — a stale
    // read, or an id collision — must not widen the candidate set.
    h.members = [{ organizationId: "org_a", createdAt: at("2026-01-01") }];
    h.orgs = [
      { id: "org_a", isTeam: false },
      { id: "org_foreign", isTeam: true },
    ];

    expect(await resolveActiveOrganizationId("u1", null)).toBe("org_a");
  });

  it("prefers a team org over the personal workspace", async () => {
    // The personal workspace is created first and is empty by default, so ordering alone
    // would land every team member in the wrong place.
    host(
      [
        { organizationId: "org_personal", createdAt: at("2026-01-01") },
        { organizationId: "org_team", createdAt: at("2026-01-02") },
      ],
      ["org_team"],
    );

    expect(await resolveActiveOrganizationId("u1", null)).toBe("org_team");
  });

  it("picks the OLDEST team org when there are several", async () => {
    host(
      [
        { organizationId: "org_new", createdAt: at("2026-06-01") },
        { organizationId: "org_old", createdAt: at("2026-01-01") },
      ],
      ["org_new", "org_old"],
    );

    expect(await resolveActiveOrganizationId("u1", null)).toBe("org_old");
  });

  describe("determinism when timestamps tie", () => {
    /**
     * Onboarding writes the personal workspace and a team org in one transaction, so equal
     * `createdAt` values are the normal case rather than a curiosity. `ORDER BY createdAt`
     * leaves the order among equals up to the planner, so without a second key two nodes
     * can disagree — and the tiebreaker used to be on the team-org branch only, leaving
     * the plain fallback as the unstable one.
     */
    const SAME = at("2026-01-01T00:00:00.000Z");

    it("breaks a tie by org id on the fallback path", async () => {
      host([
        { organizationId: "org_zzz", createdAt: SAME },
        { organizationId: "org_aaa", createdAt: SAME },
      ]);

      expect(await resolveActiveOrganizationId("u1", null)).toBe("org_aaa");
    });

    it("and gives the same answer when the rows arrive reversed", async () => {
      host([
        { organizationId: "org_aaa", createdAt: SAME },
        { organizationId: "org_zzz", createdAt: SAME },
      ]);

      expect(await resolveActiveOrganizationId("u1", null)).toBe("org_aaa");
    });

    it("breaks a tie by org id among team orgs too", async () => {
      host(
        [
          { organizationId: "org_team_z", createdAt: SAME },
          { organizationId: "org_team_a", createdAt: SAME },
        ],
        ["org_team_z", "org_team_a"],
      );

      expect(await resolveActiveOrganizationId("u1", null)).toBe("org_team_a");
    });
  });

  it("returns null for a user with no memberships", async () => {
    host([]);

    expect(await resolveActiveOrganizationId("u1", "org_anything")).toBeNull();
  });

  it("returns null rather than throwing when memberships cannot be read", async () => {
    // Callers decide whether that is a 403 or a pass-through (org-free routes), so a
    // transport failure must not become a 500 from the middleware.
    h.membersError = new Error("connection terminated");

    expect(await resolveActiveOrganizationId("u1", null)).toBeNull();
  });

  it("still resolves when the org lookup fails, treating none as a team org", async () => {
    // Losing `isTeam` costs the team-org PREFERENCE, not the answer. Failing here would
    // log every user out of a working session over a read that only ranks candidates.
    h.members = [
      { organizationId: "org_a", createdAt: at("2026-01-01") },
      { organizationId: "org_b", createdAt: at("2026-01-02") },
    ];
    h.orgsError = new Error("connection terminated");

    expect(await resolveActiveOrganizationId("u1", null)).toBe("org_a");
  });

  it("tolerates a null createdAt without reordering the rest", async () => {
    // `member.createdAt` is nullable in the schema; `new Date(null ?? 0)` is the epoch,
    // so such a row sorts first rather than turning the comparison into NaN — which would
    // make the sort's result depend on the engine's pivot choice.
    host([
      { organizationId: "org_dated", createdAt: at("2026-01-01") },
      { organizationId: "org_undated", createdAt: null },
    ]);

    expect(await resolveActiveOrganizationId("u1", null)).toBe("org_undated");
  });
});
