import { describe, it, expect, vi } from "vitest";
import type { RequestContext } from "../../src/lib/request-context";

/**
 * THE ANTI-UI-LIE RATCHET.
 *
 * A grantable resource type that no enforcement path can satisfy is worse than no
 * option at all: the owner picks it, the mint accepts it, and every call it was
 * meant to authorize returns 404. That shipped twice —
 *
 *   • `github`  — advertised to any holder of a github-family grant by
 *     mcp-tools.ts, then denied at call time because the route asserted
 *     {github,"*"} and `loadRootOrgId` has no "github" case.
 *   • `billing` / `audit` — offered by the resource catalog at resourceId "*",
 *     accepted by the mint (which evaluates the MINTER's role), then denied at use
 *     (which evaluates the token as `restricted`, whose arm re-resolved via
 *     `resolveResourceOrg` and got null for "*").
 *
 * Root cause in one line: for a scoped principal a "*" grant was inert for every
 * type except `project`, while mint-time acceptance had no such gap.
 *
 * This test enumerates GRANTABLE_RESOURCE_TYPES and requires each entry to be
 * provably authorized through exactly one of the two doors below. Add a type to
 * the grantable surface without proving it authorizes something → this fails.
 */

vi.mock("@repo/db", () => ({
  repos: {
    member: { find: vi.fn(async () => ({ id: "m1", role: "member" })) },
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

import { checkPermission, ORG_SINGLETON_RESOURCES } from "../../src/lib/permission";
import { GRANTABLE_RESOURCE_TYPES } from "../../src/lib/grantable-types";
import { canUseGitHubRepo } from "../../src/modules/github/github-access";

type G = { resourceType: string; resourceId: string; permissions: string[] };

/** Fake GrantSource mirroring the repo's specific-over-wildcard preference. */
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

const scoped = (grants: G[]) => ({ roleOverride: "restricted" as const, grants: source(grants) });
const RWA = ["read", "write", "admin"];

/** Door 1: the general path. */
async function authorizedByCheckPermission(g: G, action: "read" | "write" | "admin"): Promise<boolean> {
  return checkPermission(
    "u1",
    "org1",
    { resourceType: g.resourceType as never, resourceId: g.resourceId, action },
    scoped([g]),
  );
}

/** Door 2: the GitHub gate. A scoped ctx so no owner auto-access applies. */
async function authorizedByGitHubGate(
  g: G,
  target: { owner: string; repo?: string | null },
): Promise<boolean> {
  const { repos } = (await import("@repo/db")) as unknown as {
    repos: { patGrant: { listByToken: ReturnType<typeof vi.fn> } };
  };
  repos.patGrant.listByToken.mockResolvedValueOnce([g] as never);
  const ctx = {
    userId: "u1",
    organizationId: "org1",
    tokenScope: { tokenId: "t1", scoped: true },
  } as unknown as RequestContext;
  return canUseGitHubRepo(ctx, target, "read");
}

/* ── Door 1: types authorized through checkPermission ───────────────────────── */

const VIA_CHECK_PERMISSION = [
  "project",
  "server",
  "mail_server",
  "backup_destination",
  "billing",
  "audit",
] as const;

describe("door 1 — authorized through checkPermission", () => {
  it("per-resource types authorize on a concrete id", async () => {
    for (const type of ["project", "server", "mail_server", "backup_destination"]) {
      const g = { resourceType: type, resourceId: "R1", permissions: RWA };
      expect(await authorizedByCheckPermission(g, "read"), `${type} read`).toBe(true);
      expect(await authorizedByCheckPermission(g, "admin"), `${type} admin`).toBe(true);
    }
  });

  it('org-singletons authorize at resourceId "*" — the billing/audit fix', async () => {
    for (const type of ["billing", "audit"]) {
      const g = { resourceType: type, resourceId: "*", permissions: ["read"] };
      expect(await authorizedByCheckPermission(g, "read"), `${type} read`).toBe(true);
      // Cumulative: a read-only grant must NOT authorize write.
      expect(await authorizedByCheckPermission(g, "write"), `${type} write`).toBe(false);
    }
  });

  it("an org-singleton with NO grant is still denied (the fix widens nothing by itself)", async () => {
    for (const type of ORG_SINGLETON_RESOURCES) {
      const ok = await checkPermission(
        "u1",
        "org1",
        { resourceType: type as never, resourceId: "*", action: "read" },
        scoped([]),
      );
      expect(ok, `${type} with no grant`).toBe(false);
    }
  });

  it("an org-singleton grant does NOT leak to a different singleton type", async () => {
    const billing = { resourceType: "billing", resourceId: "*", permissions: RWA };
    const ok = await checkPermission(
      "u1",
      "org1",
      { resourceType: "audit" as never, resourceId: "*", action: "read" },
      scoped([billing]),
    );
    expect(ok).toBe(false);
  });

  it('"create" is never satisfied by an org-singleton grant', async () => {
    const g = { resourceType: "billing", resourceId: "*", permissions: RWA };
    const ok = await checkPermission(
      "u1",
      "org1",
      { resourceType: "billing" as never, resourceId: "*", action: "create" },
      scoped([g]),
    );
    expect(ok).toBe(false);
  });
});

/* ── Door 2: types authorized through the GitHub gate ───────────────────────── */

const VIA_GITHUB_GATE = ["github_installation", "github_repository"] as const;

describe("door 2 — authorized through the GitHub gate", () => {
  it("github_installation authorizes every repo under the granted owner login", async () => {
    const g = { resourceType: "github_installation", resourceId: "hydralerne", permissions: ["read"] };
    expect(await authorizedByGitHubGate(g, { owner: "hydralerne", repo: "charts" })).toBe(true);
  });

  it("github_repository authorizes exactly the granted repo and no other", async () => {
    const g = {
      resourceType: "github_repository",
      resourceId: "hydralerne/charts",
      permissions: ["read"],
    };
    expect(await authorizedByGitHubGate(g, { owner: "hydralerne", repo: "charts" })).toBe(true);
    const other = { resourceType: "github_repository", resourceId: "hydralerne/charts", permissions: ["read"] };
    expect(await authorizedByGitHubGate(other, { owner: "hydralerne", repo: "secrets" })).toBe(false);
  });
});

/* ── The ratchet ────────────────────────────────────────────────────────────── */

describe("every grantable type is provably satisfiable", () => {
  it("GRANTABLE_RESOURCE_TYPES is exactly the union of the two doors", () => {
    const covered = [...VIA_CHECK_PERMISSION, ...VIA_GITHUB_GATE].sort();
    const grantable = [...GRANTABLE_RESOURCE_TYPES].sort();
    expect(
      grantable,
      "a grantable type with no proven enforcement door is a UI lie — prove it " +
        "authorizes something above, or remove it from the grantable surface",
    ).toEqual(covered);
  });
});
