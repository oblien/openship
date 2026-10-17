import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "hono";
import type { RequestContext } from "../../../src/lib/request-context";

/**
 * Capabilities at mint: a minter can hand out a capability only with the reach it
 * stands for (`domains:delete` needs admin over that project's domains), only on
 * the type that holds it (a project), and never on the project wildcard. The minter
 * here is a restricted member holding project `read`+`write` on proj_a.
 */

const OWNER_ORG = "orgA";
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

const { upsertOAuthBindingWithGrants } = mocks;

vi.mock("@repo/db", () => ({
  repos: {
    member: {
      find: vi.fn(async (orgId: string, userId: string) => {
        if (userId !== "u1") return null;
        if (orgId === "orgA") return { id: "mA", role: "restricted" };
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
    project: {
      findById: vi.fn(async (id: string) =>
        id === "proj_a" ? { id, organizationId: "orgA" } : null,
      ),
      findEnvVarById: vi.fn(async () => null),
    },
    server: {
      get: vi.fn(async (id: string) => (id === "srv_a" ? { id, organizationId: "orgA" } : null)),
    },
    backupDestination: { findById: vi.fn(async () => null) },
    deployment: { findById: vi.fn(async () => null), findBuildSession: vi.fn(async () => null) },
    domain: { findById: vi.fn(async () => null) },
    service: { findById: vi.fn(async () => null) },
    backupPolicy: { findById: vi.fn(async () => null) },
    backupRun: { findById: vi.fn(async () => null) },
    backupRestore: { findById: vi.fn(async () => null) },
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { CLOUD_MODE: false } }));

import { authorizeMcpClient } from "@repo/platform/engine/modules/tokens/token.service";

async function serviceReply(work: Promise<unknown>): Promise<Reply> {
  try {
    return { body: { data: (await work) as never }, status: 200 };
  } catch (error) {
    const e = error as { message: string; code?: string; statusCode?: number };
    return { body: { error: e.message, code: e.code }, status: e.statusCode ?? 500 };
  }
}

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
      header: (n: string) => (n.toLowerCase() === "x-organization-id" ? activeOrg : undefined),
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
    role: "restricted",
    membershipId: "mA",
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
  return serviceReply(authorizeMcpClient(c.get("ctx"), body as never));
}

beforeEach(() => {
  mocks.state.grantsByOrg = {
    orgA: [{ resourceType: "project", resourceId: "proj_a", permissions: ["read", "write"] }],
  };
  upsertOAuthBindingWithGrants.mockClear();
});

const mint = (grants: Grant[]) =>
  authorize(OWNER_ORG, { clientId: "cli", organizationId: OWNER_ORG, grants });

describe("minting capability grants", () => {
  it("accepts capabilities within the minter's reach and stores them as given", async () => {
    const grants = [
      {
        resourceType: "project",
        resourceId: "proj_a",
        permissions: ["domains:read", "domains:write", "deployments:trigger"],
      },
    ];
    const r = await mint(grants);
    expect(r.status).toBe(200);
    expect(upsertOAuthBindingWithGrants).toHaveBeenCalledWith(
      expect.objectContaining({ grants: [expect.objectContaining(grants[0])] }),
    );
  });

  it("refuses a capability above the minter's own level", async () => {
    const r = await mint([
      {
        resourceType: "project",
        resourceId: "proj_a",
        permissions: ["domains:read", "domains:delete"],
      },
    ]);
    expect(r).toMatchObject({ status: 403, body: { code: "GRANT_EXCEEDS_ACCESS" } });
    expect(upsertOAuthBindingWithGrants).not.toHaveBeenCalled();
    mocks.state.grantsByOrg.orgA = [
      { resourceType: "project", resourceId: "proj_a", permissions: ["admin"] },
    ];
    expect(
      (
        await mint([
          { resourceType: "project", resourceId: "proj_a", permissions: ["domains:delete"] },
        ])
      ).status,
    ).toBe(200);
  });

  it("refuses a capability on a project the minter cannot reach", async () => {
    const r = await mint([
      { resourceType: "project", resourceId: "proj_other", permissions: ["domains:read"] },
    ]);
    expect(r).toMatchObject({ status: 403, body: { code: "GRANT_EXCEEDS_ACCESS" } });
  });

  it("refuses a capability on a type that does not hold it, and on the project wildcard", async () => {
    expect(
      await mint([{ resourceType: "server", resourceId: "srv_a", permissions: ["domains:read"] }]),
    ).toMatchObject({ status: 400, body: { code: "INVALID_CAPABILITY" } });
    expect(
      await mint([{ resourceType: "project", resourceId: "*", permissions: ["domains:read"] }]),
    ).toMatchObject({ status: 400, body: { code: "INVALID_GRANT_SCOPE" } });
  });
});
