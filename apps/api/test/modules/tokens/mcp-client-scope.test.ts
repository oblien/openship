/**
 * Reading and re-scoping a connected MCP client.
 *
 * `POST /api/tokens/mcp-authorize` was always an idempotent re-scope — the binding
 * upserts on (userId, clientId) and its id is stable, so an issued OAuth token keeps
 * resolving to it and the new scope applies on the agent's very next request. What
 * was missing was the READ half, and three guards that only an EDIT needs:
 *
 *   1. The binding must already exist. Consent may create one and deliberately
 *      accepts any clientId; an edit with a typo'd id would otherwise create a
 *      second, unreachable binding instead of changing the visible one.
 *   2. The org may not be rewritten. Every resource id in the editor came from the
 *      binding's current org.
 *   3. Widening to unscoped must be confirmed. It takes effect immediately with no
 *      reconnect, so it is the one direction a mis-click cannot be walked back from.
 *
 * And the write is now ONE transaction, because the old delete-then-insert left a
 * window where the binding was `scoped: true` with zero grants — deny-all. At consent
 * that is a client that never worked; on an edit it is a live agent that silently
 * lost all access mid-save.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "hono";
import type { RequestContext } from "../../../src/lib/request-context";

const ORG = "org1";

type Grant = {
  resourceType: string;
  resourceId: string;
  permissions: string[];
  scope?: unknown;
};

const mocks = vi.hoisted(() => ({
  state: {
    /** The stored binding, or null for "not connected". */
    binding: null as null | {
      id: string;
      oauthClientId: string;
      name: string;
      organizationId: string | null;
      readOnly: boolean;
      scoped: boolean;
      createdAt: Date;
      lastUsedAt: Date | null;
      useCount: number;
    },
    /** Grants attached to that binding. */
    grants: [] as Grant[],
    /** Grants the acting user holds, so validateGrants can pass. */
    userGrants: [] as Grant[],
  },
  upsertOAuthBindingWithGrants: vi.fn(async (args: { organizationId: string | null }) => ({
    id: "binding1",
    readOnly: false,
    scoped: true,
    organizationId: args.organizationId,
  })),
  auditCreate: vi.fn(async () => {}),
  disconnectMcpClient: vi.fn(async () => {}),
}));

vi.mock("@repo/db", () => ({
  repos: {
    member: { find: vi.fn(async (_o: string, u: string) => (u === "u1" ? { id: "m1", role: "owner" } : null)) },
    resourceGrant: {
      listByMember: vi.fn(async () => mocks.state.userGrants),
      findForResource: vi.fn(async (_o: string, _u: string, type: string, id: string) => {
        const held = mocks.state.userGrants;
        return (
          held.find((g) => g.resourceType === type && g.resourceId === id) ??
          held.find((g) => g.resourceType === type && g.resourceId === "*") ??
          null
        );
      }),
    },
    patGrant: {
      listByToken: vi.fn(async () => mocks.state.grants),
      findForResource: vi.fn(async () => null),
      createMany: vi.fn(async () => {}),
      deleteByToken: vi.fn(async () => {}),
    },
    personalAccessToken: {
      findOAuthBinding: vi.fn(async () => mocks.state.binding),
      upsertOAuthBindingWithGrants: mocks.upsertOAuthBindingWithGrants,
    },
    organization: { findManyById: vi.fn(async () => [{ id: ORG, name: "Acme" }]) },
    oauth: {
      listApplicationsByClientIds: vi.fn(async () => [{ clientId: "cli1", name: "Claude Code" }]),
      disconnectMcpClient: mocks.disconnectMcpClient,
    },
    auditEvent: { create: mocks.auditCreate },
    project: { findById: vi.fn(async (id: string) => ({ id, organizationId: ORG })), findEnvVarById: vi.fn(async () => null) },
    server: { get: vi.fn(async (id: string) => ({ id, organizationId: ORG })) },
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

import {
  authorizeMcpClient,
  disconnectMcpClient,
  getMcpClient,
} from "../../../src/modules/tokens/token.controller";

interface Reply {
  body: { data?: Record<string, unknown>; error?: string; code?: string };
  status: number;
}

function request(body: unknown, params: Record<string, string> = {}): { c: Context; reply: () => Reply } {
  let captured: Reply | undefined;
  const c = {
    req: {
      json: async () => body,
      header: (n: string) => (n.toLowerCase() === "x-organization-id" ? ORG : undefined),
      param: (n: string) => params[n],
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
    organizationId: ORG,
    role: "owner",
    membershipId: "m1",
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

async function authorize(body: unknown): Promise<Reply> {
  const { c, reply } = request(body);
  await authorizeMcpClient(c);
  return reply();
}

async function read(clientId: string): Promise<Reply> {
  const { c, reply } = request({}, { clientId });
  await getMcpClient(c);
  return reply();
}

async function disconnect(clientId: string): Promise<Reply> {
  const { c, reply } = request({}, { clientId });
  await disconnectMcpClient(c);
  return reply();
}

function connect(over: Partial<NonNullable<typeof mocks.state.binding>> = {}) {
  mocks.state.binding = {
    id: "binding1",
    oauthClientId: "cli1",
    name: "MCP client cli1",
    organizationId: ORG,
    readOnly: false,
    scoped: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    lastUsedAt: null,
    useCount: 0,
    ...over,
  };
}

const PROJECT_GRANT: Grant = { resourceType: "project", resourceId: "P1", permissions: ["read", "write"] };

beforeEach(() => {
  mocks.state.binding = null;
  mocks.state.grants = [];
  // Owner role satisfies validateGrants via roleAllowsResourceType, so the user
  // grant table only matters for scoped-minter cases.
  mocks.state.userGrants = [];
  mocks.upsertOAuthBindingWithGrants.mockClear();
  mocks.auditCreate.mockClear();
  mocks.disconnectMcpClient.mockClear();
});

describe("GET one client", () => {
  it("404s when the client is not connected", async () => {
    const r = await read("cli1");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("MCP_CLIENT_NOT_CONNECTED");
  });

  it("returns the binding with its grants, and the registered client name", async () => {
    connect();
    mocks.state.grants = [PROJECT_GRANT];
    const r = await read("cli1");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      clientId: "cli1",
      name: "Claude Code",
      organizationId: ORG,
      organizationName: "Acme",
      scoped: true,
      grantCount: 1,
    });
    expect(r.body.data?.grants).toEqual([
      { resourceType: "project", resourceId: "P1", permissions: ["read", "write"] },
    ]);
  });

  it("round-trips a source scope — dropping it on load would strip it on save", async () => {
    connect();
    const scope = { read: { paths: ["src/**"] } };
    mocks.state.grants = [
      { resourceType: "github_repository", resourceId: "acme/app", permissions: ["read"], scope },
    ];
    const r = await read("cli1");
    expect((r.body.data?.grants as Grant[])[0]?.scope).toEqual(scope);
  });

  it("never leaks the grant row id or the repo's stubbed org/user placeholders", async () => {
    connect();
    mocks.state.grants = [
      { ...PROJECT_GRANT, ...({ id: "patgrant_x", organizationId: "", userId: "" } as object) },
    ];
    const r = await read("cli1");
    const g = (r.body.data?.grants as Record<string, unknown>[])[0]!;
    expect(Object.keys(g).sort()).toEqual(["permissions", "resourceId", "resourceType"]);
  });

  it("grantCount on the detail equals its own grants length", async () => {
    connect();
    mocks.state.grants = [PROJECT_GRANT, { ...PROJECT_GRANT, resourceId: "P2" }];
    const r = await read("cli1");
    expect(r.body.data?.grantCount).toBe(2);
    expect((r.body.data?.grants as unknown[]).length).toBe(2);
  });
});

describe("edit requires an existing binding", () => {
  it("404s an edit for a client that was never connected", async () => {
    const r = await authorize({ clientId: "cli1", mode: "edit", grants: [PROJECT_GRANT] });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("MCP_CLIENT_NOT_CONNECTED");
    expect(mocks.upsertOAuthBindingWithGrants).not.toHaveBeenCalled();
  });

  it("consent still creates one for an unknown client", async () => {
    const r = await authorize({ clientId: "cli1", grants: [PROJECT_GRANT] });
    expect(r.status).toBe(200);
    expect(mocks.upsertOAuthBindingWithGrants).toHaveBeenCalled();
  });
});

describe("edit may not re-bind the org", () => {
  it("rejects an edit naming a different organization", async () => {
    connect();
    const r = await authorize({
      clientId: "cli1",
      mode: "edit",
      organizationId: "other-org",
      grants: [PROJECT_GRANT],
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("ORG_REBIND_NOT_ALLOWED");
    expect(mocks.upsertOAuthBindingWithGrants).not.toHaveBeenCalled();
  });

  it("accepts an edit that names the same organization explicitly", async () => {
    connect();
    const r = await authorize({
      clientId: "cli1",
      mode: "edit",
      organizationId: ORG,
      grants: [PROJECT_GRANT],
    });
    expect(r.status).toBe(200);
  });
});

describe("widening a live client must be confirmed", () => {
  it("refuses scoped → unscoped without confirmWiden", async () => {
    connect({ scoped: true });
    mocks.state.grants = [PROJECT_GRANT];
    const r = await authorize({ clientId: "cli1", mode: "edit", fullAccess: true, grants: [] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("SCOPE_WIDEN_NOT_CONFIRMED");
    expect(mocks.upsertOAuthBindingWithGrants).not.toHaveBeenCalled();
  });

  it("allows it with confirmWiden", async () => {
    connect({ scoped: true });
    mocks.state.grants = [PROJECT_GRANT];
    const r = await authorize({
      clientId: "cli1",
      mode: "edit",
      fullAccess: true,
      grants: [],
      confirmWiden: true,
    });
    expect(r.status).toBe(200);
    expect(mocks.upsertOAuthBindingWithGrants).toHaveBeenCalledWith(
      expect.objectContaining({ scoped: false }),
    );
  });

  it("NARROWING needs no confirmation — it can only remove access", async () => {
    connect({ scoped: true });
    mocks.state.grants = [PROJECT_GRANT, { ...PROJECT_GRANT, resourceId: "P2" }];
    const r = await authorize({ clientId: "cli1", mode: "edit", grants: [PROJECT_GRANT] });
    expect(r.status).toBe(200);
  });

  it("does not gate a CONSENT that is unscoped by choice", async () => {
    // "Full account access" is a legitimate first-connect pick; the guard is about
    // changing a client that is already running under a narrower scope.
    const r = await authorize({ clientId: "cli1", fullAccess: true, grants: [] });
    expect(r.status).toBe(200);
  });

  it("does not gate an already-unscoped binding staying unscoped", async () => {
    connect({ scoped: false });
    const r = await authorize({ clientId: "cli1", mode: "edit", fullAccess: true, grants: [] });
    expect(r.status).toBe(200);
  });
});

describe("the write is one call, and unrevoke is mode-dependent", () => {
  it("consent may clear a stale revocation; an edit may not", async () => {
    await authorize({ clientId: "cli1", grants: [PROJECT_GRANT] });
    expect(mocks.upsertOAuthBindingWithGrants).toHaveBeenCalledWith(
      expect.objectContaining({ unrevoke: true }),
    );

    mocks.upsertOAuthBindingWithGrants.mockClear();
    connect();
    await authorize({ clientId: "cli1", mode: "edit", grants: [PROJECT_GRANT] });
    expect(mocks.upsertOAuthBindingWithGrants).toHaveBeenCalledWith(
      expect.objectContaining({ unrevoke: false }),
    );
  });

  it("passes the grants into the same call that writes the binding", async () => {
    connect();
    await authorize({ clientId: "cli1", mode: "edit", grants: [PROJECT_GRANT] });
    expect(mocks.upsertOAuthBindingWithGrants).toHaveBeenCalledWith(
      expect.objectContaining({
        scoped: true,
        grants: [expect.objectContaining({ resourceType: "project", resourceId: "P1" })],
      }),
    );
  });
});

describe("the audit row carries counts, never the grant tuples", () => {
  it("records mcp.authorized on consent and mcp.scope_changed on edit", async () => {
    await authorize({ clientId: "cli1", grants: [PROJECT_GRANT] });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "mcp.authorized" }),
    );

    mocks.auditCreate.mockClear();
    connect();
    mocks.state.grants = [PROJECT_GRANT];
    await authorize({ clientId: "cli1", mode: "edit", grants: [PROJECT_GRANT, { ...PROJECT_GRANT, resourceId: "P2" }] });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "mcp.scope_changed" }),
    );
  });

  it("serializes before/after as counts and flags only", async () => {
    connect({ scoped: true, readOnly: false });
    mocks.state.grants = [PROJECT_GRANT];
    await authorize({ clientId: "cli1", mode: "edit", grants: [PROJECT_GRANT] });

    const call = mocks.auditCreate.mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
    const blob = JSON.stringify(call);
    // A resource id appearing anywhere in the row means the tuples leaked. The audit
    // table is readable by more roles than the grant tables, and a github grant's
    // source scope would put repo paths into it.
    expect(blob).not.toContain("P1");
    expect(call.before).toMatchObject({ scoped: true, readOnly: false, grantCount: 1 });
    expect(call.after).toMatchObject({ scoped: true, grantCount: 1 });
  });

  it("has no before-state on a first consent", async () => {
    await authorize({ clientId: "cli1", grants: [PROJECT_GRANT] });
    const call = mocks.auditCreate.mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
    expect(call.before ?? null).toBeNull();
  });
});

/**
 * Authorizing and re-scoping an agent were recorded; REVOKING it was not. That
 * left the one MCP lifecycle event with no trace, and a log that reads as though a
 * client which is long gone still holds the scope it was last seen with.
 */
describe("disconnecting is recorded too", () => {
  it("records mcp.disconnected with the scope the client HELD", async () => {
    connect({ scoped: true, readOnly: true, useCount: 42 });
    mocks.state.grants = [PROJECT_GRANT, { ...PROJECT_GRANT, resourceId: "P2" }];

    const r = await disconnect("cli1");
    expect(r.status).toBe(200);
    expect(mocks.disconnectMcpClient).toHaveBeenCalledWith("u1", "cli1");

    const call = mocks.auditCreate.mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
    expect(call).toMatchObject({
      eventType: "mcp.disconnected",
      resourceType: "mcp_client",
      resourceId: "binding1",
      organizationId: ORG,
    });
    // Read BEFORE the teardown — afterwards the binding and its grants are gone,
    // and the row could only have said "something named cli1 was disconnected".
    expect(call.before).toMatchObject({
      clientId: "cli1",
      scoped: true,
      readOnly: true,
      grantCount: 2,
      useCount: 42,
    });
    expect(call.after ?? null).toBeNull();
  });

  it("keeps the grant tuples out of the row, like every other mcp.* event", async () => {
    connect();
    mocks.state.grants = [PROJECT_GRANT];
    await disconnect("cli1");
    const call = mocks.auditCreate.mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
    expect(JSON.stringify(call)).not.toContain("P1");
  });

  it("still records when the binding is already gone", async () => {
    // A double-click, or a client disconnected in another tab: the teardown is
    // idempotent, and the attempt is still part of the history.
    mocks.state.binding = null;
    const r = await disconnect("cli1");
    expect(r.status).toBe(200);
    const call = mocks.auditCreate.mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
    expect(call).toMatchObject({ eventType: "mcp.disconnected", resourceId: "cli1" });
    expect(call.before).toEqual({ clientId: "cli1" });
  });

  it("400s on a blank clientId, and tears down nothing", async () => {
    // A present-but-empty param: an absent one throws in `param()` and is mapped
    // by the error handler, so this guard is what catches "/mcp-clients/%20".
    const r = await disconnect("   ");
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("CLIENT_ID_REQUIRED");
    expect(mocks.disconnectMcpClient).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe("the client list carries its usage", () => {
  it("reports the call count and the key for this client's audit rows", async () => {
    connect({ useCount: 1204 });
    const r = await read("cli1");
    expect(r.body.data).toMatchObject({ useCount: 1204, auditClientId: "oauth:cli1" });
  });
});
