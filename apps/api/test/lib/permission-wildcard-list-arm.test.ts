/**
 * The collection/wildcard arm of `checkPermission`.
 *
 * Every assertion at resourceId "*" — a `:list` scope, a `collection: true` write,
 * or an org-singleton route — is authorized by a wildcard grant on that same type
 * and by nothing else. This replaced an arm that applied the identical rule to
 * org-singletons ONLY, which left a per-resource wildcard grant able to reach every
 * row of its type by id (the grant lookup matches `resource_id = $id OR
 * resource_id = '*'`) while 404ing on enumerating them.
 *
 * The delicate part is the interaction with the `{project,"*",[create]}` scope
 * ("projects it creates"). That arm runs FIRST and must keep authorizing exactly
 * two things — the dedicated create route and the project list — while a
 * create-only grant must still be denied every other collection write. `create` is
 * not cumulative (`permitsAction` returns false for it on every action), so if the
 * wildcard arm ran first, being terminal, it would deny both. Order is the fix and
 * these tests are what pin it.
 */

import { describe, it, expect, vi } from "vitest";

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

import { checkPermission, permitsAction } from "../../src/lib/permission";
import { ORG_SINGLETON_RESOURCE_TYPES } from "@repo/core";

type G = { resourceType: string; resourceId: string; permissions: string[] };
type Action = "read" | "write" | "admin";

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

function can(
  grants: G[],
  input: { resourceType: string; resourceId: string; action: Action; scope?: "list"; projectCreate?: boolean },
): Promise<boolean> {
  return checkPermission(
    "u1",
    "org1",
    {
      resourceType: input.resourceType as never,
      resourceId: input.resourceId,
      action: input.action,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.projectCreate !== undefined ? { projectCreate: input.projectCreate } : {}),
    } as never,
    scoped(grants),
  );
}

const wildcard = (type: string, permissions: string[]): G => ({
  resourceType: type,
  resourceId: "*",
  permissions,
});

describe("a wildcard grant authorizes its own type's collection", () => {
  it("satisfies a :list assertion at the granted verb and below", async () => {
    const g = [wildcard("server", ["read"])];
    expect(await can(g, { resourceType: "server", resourceId: "*", action: "read", scope: "list" })).toBe(true);
  });

  it("satisfies a collection write when the grant carries write", async () => {
    const g = [wildcard("server", ["read", "write"])];
    expect(await can(g, { resourceType: "server", resourceId: "*", action: "write" })).toBe(true);
  });

  it("is cumulative, not permissive — read does not buy write or admin", async () => {
    const g = [wildcard("server", ["read"])];
    expect(await can(g, { resourceType: "server", resourceId: "*", action: "write" })).toBe(false);
    expect(await can(g, { resourceType: "server", resourceId: "*", action: "admin" })).toBe(false);
  });

  it("does not cross type boundaries", async () => {
    const g = [wildcard("server", ["read", "write", "admin"])];
    expect(await can(g, { resourceType: "mail_server", resourceId: "*", action: "read" })).toBe(false);
    expect(await can(g, { resourceType: "backup_destination", resourceId: "*", action: "read" })).toBe(false);
  });

  it("a PER-ID grant does not satisfy the collection — that is the whole point", async () => {
    const g = [{ resourceType: "server", resourceId: "S1", permissions: ["read", "write", "admin"] }];
    expect(await can(g, { resourceType: "server", resourceId: "*", action: "read", scope: "list" })).toBe(false);
    // ...but it still reaches its own row.
    expect(await can(g, { resourceType: "server", resourceId: "S1", action: "admin" })).toBe(true);
  });

  it("no grant at all is denied", async () => {
    expect(await can([], { resourceType: "server", resourceId: "*", action: "read", scope: "list" })).toBe(false);
  });
});

describe("the arm covers what it replaced", () => {
  it("every org-singleton type still authorizes from a {type,*} grant", async () => {
    for (const type of ORG_SINGLETON_RESOURCE_TYPES) {
      const g = [wildcard(type, ["read"])];
      expect(await can(g, { resourceType: type, resourceId: "*", action: "read" }), `${type} read`).toBe(true);
      expect(await can(g, { resourceType: type, resourceId: "*", action: "write" }), `${type} write`).toBe(false);
    }
  });

  it("an org-singleton with no grant is still denied", async () => {
    for (const type of ORG_SINGLETON_RESOURCE_TYPES) {
      expect(await can([], { resourceType: type, resourceId: "*", action: "read" }), type).toBe(false);
    }
  });
});

describe("the {project,*,[create]} scope is unchanged", () => {
  const createOnly = [wildcard("project", ["create"])];

  it("still reaches the dedicated create route", async () => {
    expect(
      await can(createOnly, {
        resourceType: "project",
        resourceId: "*",
        action: "write",
        projectCreate: true,
      }),
    ).toBe(true);
  });

  it("still reaches the project list", async () => {
    expect(await can(createOnly, { resourceType: "project", resourceId: "*", action: "read" })).toBe(true);
  });

  it("still cannot reach other collection writes (ensure / scan / import)", async () => {
    // No projectCreate flag ⇒ not the create route. Falls through to the wildcard
    // arm, where `permitsAction(["create"], "write")` is false. This is the case
    // that breaks if the wildcard arm is ever moved ABOVE the create arm.
    expect(await can(createOnly, { resourceType: "project", resourceId: "*", action: "write" })).toBe(false);
    expect(await can(createOnly, { resourceType: "project", resourceId: "*", action: "admin" })).toBe(false);
  });

  it("still cannot reach an existing project by id", async () => {
    expect(await can(createOnly, { resourceType: "project", resourceId: "P1", action: "read" })).toBe(false);
  });

  it("`create` authorizes no action through permitsAction — the ordering premise", () => {
    for (const action of ["read", "write", "admin"] as const) {
      expect(permitsAction(["create"], action), action).toBe(false);
    }
  });
});

describe("a full project wildcard now lists and creates (deliberate widening)", () => {
  // The member picker offers "All projects · read/write/admin". Such a grant
  // already reached every project by id; it could not enumerate them. Both now
  // resolve through one rule. Tokens are unaffected — `wildcardProjectGrantRejected`
  // keeps {project,"*"} create-only at mint.
  const full = [wildcard("project", ["read", "write", "admin"])];

  it("lists projects", async () => {
    expect(await can(full, { resourceType: "project", resourceId: "*", action: "read", scope: "list" })).toBe(true);
  });

  it("creates projects", async () => {
    expect(
      await can(full, { resourceType: "project", resourceId: "*", action: "write", projectCreate: true }),
    ).toBe(true);
  });

  it("still reaches an individual project by id", async () => {
    expect(await can(full, { resourceType: "project", resourceId: "P1", action: "admin" })).toBe(true);
  });
});

describe("non-restricted roles are untouched by this arm", () => {
  it("a member is authorized by role, without consulting grants", async () => {
    const boom = {
      findForResource: async () => {
        throw new Error("the role arm must return before any grant lookup");
      },
      listByMember: async () => [],
    } as never;
    await expect(
      checkPermission(
        "u1",
        "org1",
        { resourceType: "server" as never, resourceId: "*", action: "admin" },
        { grants: boom },
      ),
    ).resolves.toBe(true);
  });
});
