import type { Context } from "hono";
import { repos, type Permission, type PublicPersonalAccessToken } from "@repo/db";
import { param } from "../../lib/controller-helpers";
import { getRequestContext, type RequestContext } from "../../lib/request-context";
import { checkPermissionOnResource } from "../../lib/permission";
import { canUseGitHubRepo } from "../github/github-access";
import { mintPatToken } from "../../lib/pat";
import { wildcardProjectGrantRejected, type TCreateTokenBody } from "./token.schema";

/** Resource types a token may be scoped to (mirrors the picker + grants API). */
const GRANTABLE_TOKEN_TYPES = new Set<string>([
  "project",
  "server",
  "mail_server",
  "backup_destination",
  "billing",
  "audit",
  "github_installation",
  "github_repository",
]);

/** Public view of a token — NEVER includes the hash or the plaintext. */
function serialize(t: PublicPersonalAccessToken) {
  return {
    id: t.id,
    name: t.name,
    tokenPrefix: t.tokenPrefix,
    readOnly: t.readOnly,
    scoped: t.scoped,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
    createdAt: t.createdAt,
  };
}

/** The strongest action a grant's permissions imply. */
function strongestAction(perms: Permission[]): Permission {
  if (perms.includes("admin")) return "admin";
  if (perms.includes("write")) return "write";
  return "read";
}

/**
 * A token can only grant access the MINTER already has — reuses the live
 * permission path (owner ⇒ everything; others ⇒ their own grants). GitHub goes
 * through its dedicated gate.
 */
async function minterHasAccess(
  ctx: RequestContext,
  g: { resourceType: string; resourceId: string; permissions: Permission[] },
): Promise<boolean> {
  const action = strongestAction(g.permissions);
  if (g.resourceType === "github_installation" || g.resourceType === "github_repository") {
    const op = action === "read" ? "read" : "write";
    const [owner, repo] =
      g.resourceType === "github_repository" ? g.resourceId.split("/") : [g.resourceId, undefined];
    return canUseGitHubRepo(ctx, { owner: owner ?? "", repo: repo ?? null }, op);
  }
  // Resolve the grant's resource to its OWN org and check access there — NOT
  // the minter's active org. Otherwise a non-restricted role passes for the
  // resource TYPE without verifying the specific id belongs to their org, so a
  // grant naming another org's resource id would mint a usable token (SaaS
  // audit: cross-tenant privilege escalation). Mirrors permission.assert.
  return checkPermissionOnResource(ctx, {
    resourceType: g.resourceType as never,
    resourceId: g.resourceId,
    action,
  });
}

/**
 * Validate a scoped token's requested grants before minting — SHARED by the PAT
 * create route and the MCP OAuth authorize path so both enforce identical rules
 * with no duplicated loop (and no drift). Returns the response to send on the
 * first invalid grant, or null when every grant is allowed.
 */
async function validateGrants(
  ctx: RequestContext,
  grants: Array<{ resourceType: string; resourceId: string; permissions: Permission[] }>,
): Promise<{ status: 400 | 403; body: { error: string; code: string } } | null> {
  for (const g of grants) {
    if (!GRANTABLE_TOKEN_TYPES.has(g.resourceType)) {
      return {
        status: 400,
        body: { error: `Invalid resource type: ${g.resourceType}`, code: "INVALID_RESOURCE_TYPE" },
      };
    }
    // Hardening: the wildcard project grant is the "projects it creates" scope
    // and MUST be create-only (see wildcardProjectGrantRejected) — never a
    // wildcard read/write/admin that would reach every project by id.
    if (wildcardProjectGrantRejected(g)) {
      return {
        status: 400,
        body: {
          error:
            'A project "*" grant must be create-only (the "projects it creates" scope). Grant specific project ids for read/write/admin.',
          code: "INVALID_GRANT_SCOPE",
        },
      };
    }
    if (!(await minterHasAccess(ctx, g))) {
      return {
        status: 403,
        body: {
          error: `You can't grant access you don't have yourself: ${g.resourceType} / ${g.resourceId}`,
          code: "GRANT_EXCEEDS_ACCESS",
        },
      };
    }
  }
  return null;
}

/** POST /api/tokens — mint a token. Returns the plaintext ONCE. */
export async function create(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TCreateTokenBody>();

  // A scoped token carries its own grants. Validate every grant is within the
  // minter's own access BEFORE minting, so a token can never exceed its owner.
  // The "projects it creates" scope is just a grant like any other:
  // {project,"*",[create]} — no special-casing here.
  const grants = (body.grants ?? []).filter((g) => g.permissions.length > 0);
  const wantScoped = grants.length > 0;
  if (wantScoped) {
    const err = await validateGrants(ctx, grants);
    if (err) return c.json(err.body, err.status);
  }

  const { token, tokenPrefix, tokenHash } = mintPatToken();
  const expiresAt = body.expiresInDays
    ? new Date(Date.now() + body.expiresInDays * 86_400_000)
    : null;

  const row = await repos.personalAccessToken.create({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    name: body.name,
    tokenPrefix,
    tokenHash,
    readOnly: body.readOnly ?? false,
    scoped: wantScoped,
    expiresAt,
  });

  if (wantScoped) {
    await repos.patGrant.createMany(
      row.id,
      grants.map((g) => ({
        resourceType: g.resourceType as never,
        resourceId: g.resourceId,
        permissions: g.permissions,
      })),
    );
  }

  // `token` is shown exactly once — it's never retrievable again.
  return c.json({ data: { ...serialize(row), token } }, 201);
}

/** GET /api/tokens — the caller's own tokens (no secrets). */
export async function list(c: Context) {
  const ctx = getRequestContext(c);
  const rows = await repos.personalAccessToken.listByUser(ctx.userId);
  return c.json({ data: rows.map(serialize) });
}

/** DELETE /api/tokens/:id — revoke one of the caller's own tokens. */
export async function revoke(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const ok = await repos.personalAccessToken.revoke(id, ctx.userId);
  if (!ok) return c.json({ error: "Token not found" }, 404);
  return c.json({ data: { revoked: true } });
}

/**
 * POST /api/tokens/mcp-authorize — record what an OAuth MCP client may access,
 * BEFORE the Better Auth consent completes and a token is issued.
 *
 * Called by the /mcp/authorize consent page (browser cookie session). Persists
 * the user's chosen read-only + resource grants as the OAuth client's binding
 * (a scoped `personal_access_token` grant-holder keyed by user+client). The
 * OAuth access token then resolves to that binding at auth time
 * (`tryOAuthMcpAuth`) and runs through the SAME scoped-principal path as a PAT.
 *
 * Grants are validated ⊆ the caller's own access (identical rule to token
 * creation), so a client can never be granted more than the user holds.
 */
export async function authorizeMcpClient(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{
    clientId?: string;
    readOnly?: boolean;
    organizationId?: string;
    grants?: Array<{ resourceType: string; resourceId: string; permissions: Permission[] }>;
  }>();

  const clientId = body.clientId?.trim();
  if (!clientId) return c.json({ error: "clientId required", code: "CLIENT_ID_REQUIRED" }, 400);

  // The org the client is confined to. The consent page switches the session's
  // active org to the picked one before calling, so ctx.organizationId is
  // normally already it; the explicit id is defense-in-depth. Any org other
  // than the active one must be re-verified as a real membership so a caller
  // can't bind a token to an org they don't belong to.
  const organizationId = body.organizationId?.trim() || ctx.organizationId;
  if (organizationId !== ctx.organizationId) {
    const membership = await repos.member.find(organizationId, ctx.userId);
    if (!membership) {
      return c.json(
        { error: "You are not a member of that organization", code: "ORG_NOT_A_MEMBER" },
        403,
      );
    }
  }

  const grants = (body.grants ?? []).filter((g) => g.permissions.length > 0);
  const scoped = grants.length > 0;

  const grantErr = await validateGrants(ctx, grants);
  if (grantErr) return c.json(grantErr.body, grantErr.status);

  const binding = await repos.personalAccessToken.upsertOAuthBinding({
    userId: ctx.userId,
    organizationId,
    oauthClientId: clientId,
    readOnly: body.readOnly ?? false,
    scoped,
  });

  // Replace the binding's grants wholesale (re-authorizing overwrites).
  await repos.patGrant.deleteByToken(binding.id);
  if (scoped) {
    await repos.patGrant.createMany(
      binding.id,
      grants.map((g) => ({
        resourceType: g.resourceType as never,
        resourceId: g.resourceId,
        permissions: g.permissions,
      })),
    );
  }

  return c.json({ data: { ok: true, scoped, readOnly: binding.readOnly } });
}

/**
 * GET /api/tokens/mcp-clients — the caller's connected MCP clients (one per
 * OAuth binding), for the settings management list. Self-scoped to ctx.userId.
 */
export async function listMcpClients(c: Context) {
  const ctx = getRequestContext(c);
  const bindings = await repos.personalAccessToken.listOAuthBindings(ctx.userId);
  if (bindings.length === 0) return c.json({ data: [] });

  const clientIds = bindings
    .map((b) => b.oauthClientId)
    .filter((id): id is string => !!id);
  const orgIds = Array.from(
    new Set(bindings.map((b) => b.organizationId).filter((id): id is string => !!id)),
  );

  const [apps, orgs, grantsPerBinding] = await Promise.all([
    repos.oauth.listApplicationsByClientIds(clientIds),
    orgIds.length ? repos.organization.findManyById(orgIds) : Promise.resolve([]),
    Promise.all(bindings.map((b) => repos.patGrant.listByToken(b.id))),
  ]);

  const nameByClient = new Map(apps.map((a) => [a.clientId, a.name]));
  const nameByOrg = new Map(orgs.map((o) => [o.id, o.name]));

  const data = bindings.map((b, i) => ({
    clientId: b.oauthClientId,
    // Registered client name; fall back to the binding's stored label.
    name: (b.oauthClientId && nameByClient.get(b.oauthClientId)) || b.name,
    organizationId: b.organizationId,
    organizationName: b.organizationId ? (nameByOrg.get(b.organizationId) ?? null) : null,
    readOnly: b.readOnly,
    scoped: b.scoped,
    grantCount: grantsPerBinding[i]?.length ?? 0,
    authorizedAt: b.createdAt,
    lastUsedAt: b.lastUsedAt,
  }));

  return c.json({ data });
}

/**
 * DELETE /api/tokens/mcp-clients/:clientId — disconnect a client. Revoke issued
 * tokens first (stops it immediately), then drop the scope binding + its grants
 * and the recorded consent so a reconnect re-prompts. All scoped to this user —
 * a client shared across users keeps working for everyone else.
 */
export async function disconnectMcpClient(c: Context) {
  const ctx = getRequestContext(c);
  const clientId = param(c, "clientId").trim();
  if (!clientId) return c.json({ error: "clientId required", code: "CLIENT_ID_REQUIRED" }, 400);

  // Atomic: tokens + consent + binding + grants are torn down in one
  // transaction (see oauth repo). Self-scoped to ctx.userId, so a client
  // shared across users keeps working for everyone else.
  await repos.oauth.disconnectMcpClient(ctx.userId, clientId);

  return c.json({ data: { ok: true } });
}
