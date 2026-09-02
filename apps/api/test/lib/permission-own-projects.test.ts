import { describe, it, expect, vi } from "vitest";

// checkPermission touches only member.find (membership gate) and, for a
// concrete project id, project.findById (org resolution). We pass the grant
// source explicitly via opts, so resourceGrant is never consulted.
vi.mock("@repo/db", () => ({
  repos: {
    member: { find: vi.fn(async () => ({ id: "m1", role: "member" })) },
    project: {
      findById: vi.fn(async (id: string) =>
        id === "*" ? null : { id, organizationId: "org1" },
      ),
    },
    resourceGrant: { findForResource: vi.fn(async () => null) },
  },
}));
vi.mock("../../src/config/env", () => ({ env: { CLOUD_MODE: false } }));

import { checkPermission } from "../../src/lib/permission";
import { wildcardProjectGrantRejected } from "../../src/modules/tokens/token.schema";

type G = { resourceType: string; resourceId: string; permissions: string[] };

// Fake GrantSource mirroring the repo's specific-over-wildcard preference.
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

// The "projects it creates" scope = a single {project,"*",[create]} grant.
const createGrant: G = { resourceType: "project", resourceId: "*", permissions: ["create"] };
const opts = (grants: G[]) => ({ roleOverride: "restricted" as const, grants: source(grants) });

describe('"projects it creates" scope (create-verb grant)', () => {
  it("allows creating a project via the dedicated create route", async () => {
    const ok = await checkPermission(
      "u1",
      "org1",
      { resourceType: "project", resourceId: "*", action: "write", projectCreate: true },
      opts([createGrant]),
    );
    expect(ok).toBe(true);
  });

  it("denies collection writes on non-create routes (ensure/scan/import)", async () => {
    const ok = await checkPermission(
      "u1",
      "org1",
      { resourceType: "project", resourceId: "*", action: "write" }, // no projectCreate marker
      opts([createGrant]),
    );
    expect(ok).toBe(false);
  });

  it("allows listing projects (results filtered to owned rows by the caller)", async () => {
    const ok = await checkPermission(
      "u1",
      "org1",
      { resourceType: "project", resourceId: "*", action: "read", scope: "list" },
      opts([createGrant]),
    );
    expect(ok).toBe(true);
  });

  it("grants full control of a project it created (auto-granted per-id)", async () => {
    const g = [createGrant, { resourceType: "project", resourceId: "P1", permissions: ["read", "write", "admin"] }];
    expect(
      await checkPermission("u1", "org1", { resourceType: "project", resourceId: "P1", action: "write" }, opts(g)),
    ).toBe(true);
    expect(
      await checkPermission("u1", "org1", { resourceType: "project", resourceId: "P1", action: "admin" }, opts(g)),
    ).toBe(true);
  });

  it("DENIES a project it did NOT create — the create grant grants no read/write on existing ids", async () => {
    expect(
      await checkPermission("u1", "org1", { resourceType: "project", resourceId: "P2", action: "read" }, opts([createGrant])),
    ).toBe(false);
    expect(
      await checkPermission("u1", "org1", { resourceType: "project", resourceId: "P2", action: "write" }, opts([createGrant])),
    ).toBe(false);
    expect(
      await checkPermission("u1", "org1", { resourceType: "project", resourceId: "P2", action: "admin" }, opts([createGrant])),
    ).toBe(false);
  });

  it("keeps a read-only project grant read-only for secured Swarm inspection routes", async () => {
    const readOnly = [{ resourceType: "project", resourceId: "P1", permissions: ["read"] }];
    expect(
      await checkPermission("u1", "org1", { resourceType: "project", resourceId: "P1", action: "read" }, opts(readOnly)),
    ).toBe(true);
    expect(
      await checkPermission("u1", "org1", { resourceType: "project", resourceId: "P1", action: "write" }, opts(readOnly)),
    ).toBe(false);
    expect(
      await checkPermission("u1", "org1", { resourceType: "project", resourceId: "P1", action: "admin" }, opts(readOnly)),
    ).toBe(false);
  });
});

// Mint-time hardening: a wildcard project grant is ONLY the create scope, so it
// must be create-only. This keeps an owner from minting {project,"*",[write]}
// (org-wide per-id reach that stays invisible in the self-created-only list).
describe("wildcardProjectGrantRejected (mint-time hardening)", () => {
  const g = (permissions: string[], resourceId = "*", resourceType = "project") => ({
    resourceType,
    resourceId,
    permissions,
  });

  it("rejects a wildcard project grant that is not exactly [create]", () => {
    expect(wildcardProjectGrantRejected(g(["read"]))).toBe(true);
    expect(wildcardProjectGrantRejected(g(["write"]))).toBe(true);
    expect(wildcardProjectGrantRejected(g(["admin"]))).toBe(true);
    expect(wildcardProjectGrantRejected(g(["create", "write"]))).toBe(true);
    expect(wildcardProjectGrantRejected(g([]))).toBe(true);
  });

  it("allows the create-only wildcard project grant (the scope itself)", () => {
    expect(wildcardProjectGrantRejected(g(["create"]))).toBe(false);
  });

  it("ignores non-wildcard project grants and non-project types", () => {
    expect(wildcardProjectGrantRejected(g(["write"], "P1"))).toBe(false);
    expect(wildcardProjectGrantRejected(g(["admin"], "*", "server"))).toBe(false);
    expect(wildcardProjectGrantRejected(g(["create"], "P1"))).toBe(false);
  });
});
