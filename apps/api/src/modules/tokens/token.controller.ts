import type { Context } from "hono";
import { repos, type Permission, type PublicPersonalAccessToken, type ResourceType } from "@repo/db";
import { param } from "../../lib/controller-helpers";
import { audit, auditContextFrom } from "../../lib/audit";
import {
  getRequestContext,
  type RequestContext,
  type RequestContextRole,
} from "../../lib/request-context";
import { checkPermissionOnResource } from "../../lib/permission";
import { canUseGitHubRepo, resolveSourceAccess } from "../github/github-access";
import {
  isGrantableResourceType,
  isOrgSingletonResourceType,
  scopeIsSubset,
  type SourceAccessScope,
} from "@repo/core";
import { mintPatToken } from "../../lib/pat";
import { wildcardProjectGrantRejected, type TCreateTokenBody } from "./token.schema";

// Token scoping and member grants offer the SAME types — they used to be two
// hand-maintained lists, which is how the PAT screen ended up offering types the
// MCP consent screen withheld. `isGrantableResourceType` is now the one answer.

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
 * A github grant's resourceId → (owner, repo). `github_repository` is
 * "owner/repo"; `github_installation` is the bare account login.
 */
function splitRepoGrant(g: { resourceType: string; resourceId: string }): {
  owner: string | undefined;
  repo: string | undefined;
} {
  const [owner, repo] =
    g.resourceType === "github_repository" ? g.resourceId.split("/") : [g.resourceId, undefined];
  return { owner, repo };
}

/**
 * A token can only grant access the MINTER already has — reuses the live
 * permission path (owner ⇒ everything; others ⇒ their own grants). GitHub goes
 * through its dedicated gate.
 *
 * `ctx` MUST already be scoped to the org the token will be bound to — see
 * `mintContextFor`. Every arm below takes its authority from `ctx.organizationId`
 * (the GitHub gate directly, `checkPermissionOnResource` as its scope org), so
 * handing this the caller's active org while binding the token elsewhere is exactly
 * the escalation GHSA-qv27-39pc-qw9f finding 1 describes.
 */
async function minterHasAccess(
  ctx: RequestContext,
  g: { resourceType: string; resourceId: string; permissions: Permission[] },
): Promise<boolean> {
  const action = strongestAction(g.permissions);
  if (g.resourceType === "github_installation" || g.resourceType === "github_repository") {
    const op = action === "read" ? "read" : "write";
    const { owner, repo } = splitRepoGrant(g);
    // "authority", not "reach": the grant written here IS the downstream
    // authority, so there is nothing left to narrow an owner-level pass. Without
    // this, one `github_repository` grant under `acme` mints an owner-wide
    // `github_installation` grant over every repo under `acme`
    // (GHSA-qv27-39pc-qw9f finding 2). Repo-level grants are unaffected — they
    // carry a concrete repo and match exactly.
    return canUseGitHubRepo(ctx, { owner: owner ?? "", repo: repo ?? null }, op, {
      ownerLevel: "authority",
    });
  }
  // Resolve the grant's resource to its OWN org and check access there — NOT
  // the minter's active org. Otherwise a non-restricted role passes for the
  // resource TYPE without verifying the specific id belongs to their org, so a
  // grant naming another org's resource id would mint a usable token (SaaS
  // audit: cross-tenant privilege escalation). Mirrors permission.assert.
  //
  // Org-singletons (billing, audit, …) have no resource row to resolve, so their
  // authority is the caller's ROLE in an org — and `checkPermissionOnResource`
  // takes that org from `ctx.organizationId`, which is why this function's
  // precondition is a ctx already scoped to the binding's org.
  return checkPermissionOnResource(ctx, {
    resourceType: g.resourceType as never,
    resourceId: g.resourceId,
    action,
  });
}

/**
 * The ctx grant validation runs against: ALWAYS scoped to the org the token will
 * be BOUND to, never the caller's active org.
 *
 * `validateGrants` takes every authority from `ctx.organizationId` — the GitHub
 * gate keys its membership + grant lookup on it, and `checkPermissionOnResource`
 * resolves the org-singleton arms from it. Validating against the active org while writing
 * the binding somewhere else is GHSA-qv27-39pc-qw9f finding 1: a plain member of
 * org B mints a token bound to org B carrying permissions they hold only in org A.
 * That precondition is free — every provisioned user gets an owner-role personal
 * workspace, and the active org is caller-chosen via `X-Organization-Id` — so
 * membership in the victim org was the only real barrier.
 *
 * Returns null when the caller is not a member of the target org. `role` and
 * `membershipId` come from the TARGET org's membership row, so no field on the
 * returned ctx still describes the caller's standing anywhere else. (Nothing on
 * this path reads `ctx.role` today — every arm re-reads the membership for the org
 * it is checking — but leaving a ctx whose org and role disagree is the shape this
 * bug had in the first place.)
 */
async function mintContextFor(
  ctx: RequestContext,
  organizationId: string,
): Promise<RequestContext | null> {
  if (organizationId === ctx.organizationId) return ctx;
  const membership = await repos.member.find(organizationId, ctx.userId);
  if (!membership) return null;
  return {
    ...ctx,
    organizationId,
    role: (membership.role ?? "member") as RequestContextRole,
    membershipId: membership.id,
  };
}

type GrantError = { status: 400 | 403; body: { error: string; code: string } };

/**
 * Scoped or unscoped — decided from EXPLICIT intent, never from `grants.length`.
 *
 * SHARED by both mint paths (PAT create + MCP authorize) so the rule cannot drift,
 * for the same reason `validateGrants` is shared.
 *
 * The old rule was `scoped = grants.length > 0`, which meant an empty grant list
 * minted an UNSCOPED binding acting with the minter's full role. That made two
 * opposite intents indistinguishable on the wire, and it failed OPEN for the
 * dangerous one: a caller that meant to scope a token but produced no usable
 * grants — including one whose grants all had empty `permissions` arrays, since
 * both callers filter those out before getting here — received full access. The
 * only thing standing between that and a live token was the consent screen's
 * client-side guard.
 *
 * Now: grants ⇒ scoped; no grants + `fullAccess: true` ⇒ unscoped; no grants and
 * no flag ⇒ refused. Sending both is refused too — an ambiguous request is a
 * caller bug, and guessing which half to honour is how this class of hole starts.
 */
export function resolveScopeIntent(opts: {
  hasGrants: boolean;
  fullAccess?: boolean;
}): { scoped: boolean } | { error: GrantError } {
  if (opts.hasGrants) {
    if (opts.fullAccess === true) {
      return {
        error: {
          status: 400,
          body: {
            error:
              "Send either `grants` (a scoped token) or `fullAccess: true` (an unscoped one), not both.",
            code: "AMBIGUOUS_TOKEN_SCOPE",
          },
        },
      };
    }
    return { scoped: true };
  }
  if (opts.fullAccess === true) return { scoped: false };
  return {
    error: {
      status: 400,
      body: {
        error:
          "No grants were given. Send `grants` to scope this token, or `fullAccess: true` to " +
          "deliberately mint one with your own full access.",
        code: "TOKEN_SCOPE_REQUIRED",
      },
    },
  };
}

/**
 * Validate a scoped token's requested grants before minting — SHARED by the PAT
 * create route and the MCP OAuth authorize path so both enforce identical rules
 * with no duplicated loop (and no drift). Returns the response to send on the
 * first invalid grant, or null when every grant is allowed.
 *
 * INVARIANT: `ctx.organizationId` must be the org the token will be BOUND to. Both
 * callers satisfy it — `create` binds to `ctx.organizationId`, and
 * `authorizeMcpClient` passes a ctx from `mintContextFor`.
 */
async function validateGrants(
  ctx: RequestContext,
  grants: Array<{
    resourceType: string;
    resourceId: string;
    permissions: Permission[];
    scope?: SourceAccessScope | null;
  }>,
): Promise<{ status: 400 | 403; body: { error: string; code: string } } | null> {
  for (const g of grants) {
    if (!isGrantableResourceType(g.resourceType)) {
      return {
        status: 400,
        body: { error: `Invalid resource type: ${g.resourceType}`, code: "INVALID_RESOURCE_TYPE" },
      };
    }
    // A feature grant is only reachable at "*" — `checkPermission`'s wildcard arm
    // looks up that id and nothing else. Stored at any other id it would make the
    // type read as granted (and advertise its MCP tools) while every call 404s.
    if (isOrgSingletonResourceType(g.resourceType) && g.resourceId !== "*") {
      return {
        status: 400,
        body: {
          error: `${g.resourceType} is granted for the whole organization — use "*" as the resource id`,
          code: "SINGLETON_REQUIRES_WILDCARD",
        },
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
    // Source scope must be contained by the minter's OWN source access for this
    // repo. Without this, a member scoped to `src/**` could mint a token granting
    // itself the whole repo — the grant loop above only checks the repo, not how
    // far into it. Resolved through the same gate that enforces at call time.
    if (g.scope && (g.resourceType === "github_repository" || g.resourceType === "github_installation")) {
      const { owner, repo } = splitRepoGrant(g);
      const mine = await resolveSourceAccess(ctx, { owner: owner ?? "", repo: repo ?? null });
      const readOk = scopeIsSubset(g.scope.read?.paths ?? [], mine.readPaths);
      const writeOk = scopeIsSubset(g.scope.write?.paths ?? [], mine.writePaths);
      if (!readOk || !writeOk) {
        return {
          status: 403,
          body: {
            error: `You can't grant source access you don't have yourself: ${g.resourceType} / ${g.resourceId}`,
            code: "GRANT_EXCEEDS_ACCESS",
          },
        };
      }
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
  const intent = resolveScopeIntent({
    hasGrants: grants.length > 0,
    fullAccess: body.fullAccess,
  });
  if ("error" in intent) return c.json(intent.error.body, intent.error.status);
  const wantScoped = intent.scoped;
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
        // Normalised by the repo on write, so a pattern the matcher would reject
        // is never stored as though it were enforceable.
        scope: g.scope,
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
    /** Explicit "no limits" intent — required when `grants` is empty. See
     *  resolveScopeIntent: an empty list no longer implies full access. */
    fullAccess?: boolean;
    /**
     * "consent" (default) is the first authorization, from the OAuth consent page.
     * "edit" re-scopes an ALREADY connected client from the settings MCP tab, which
     * adds three requirements consent doesn't have — see the guards below.
     */
    mode?: "consent" | "edit";
    /** Required to widen an edit to unscoped. See the widen guard. */
    confirmWiden?: boolean;
    grants?: Array<{
      resourceType: string;
      resourceId: string;
      permissions: Permission[];
      /** Repo source access. Omitted ⇒ metadata only — the consent screen has to
       *  send this explicitly for an agent to read file contents. */
      scope?: SourceAccessScope | null;
    }>;
  }>();

  const clientId = body.clientId?.trim();
  if (!clientId) return c.json({ error: "clientId required", code: "CLIENT_ID_REQUIRED" }, 400);

  const mode = body.mode === "edit" ? "edit" : "consent";

  // An EDIT must target a binding that already exists. Consent may create one, and
  // deliberately accepts any clientId string — Better Auth won't issue a token for
  // an unregistered client, so those rows are inert. An edit has no such excuse: a
  // typo'd id would silently create a second, unreachable binding instead of
  // changing the one the user is looking at.
  const existing = await repos.personalAccessToken.findOAuthBinding(ctx.userId, clientId);
  if (mode === "edit" && !existing) {
    return c.json({ error: "MCP client is not connected", code: "MCP_CLIENT_NOT_CONNECTED" }, 404);
  }

  // The org the client is confined to. The consent page switches the session's
  // active org to the picked one before calling, so ctx.organizationId is
  // normally already it; the explicit id is defense-in-depth. Any org other
  // than the active one must be re-verified as a real membership so a caller
  // can't bind a token to an org they don't belong to — and, since the grants
  // are validated against the org the binding is WRITTEN to, the same lookup
  // supplies the ctx that validation runs against.
  const organizationId = body.organizationId?.trim() || ctx.organizationId;

  // An edit must not RE-BIND a live client to a different org. Every resource id in
  // the editor was picked from the binding's current org, so rewriting the org while
  // keeping those ids would produce grants that name resources the new org doesn't
  // contain — and `upsertOAuthBinding` would happily do it.
  if (mode === "edit" && existing && organizationId !== existing.organizationId) {
    return c.json(
      {
        error: "An MCP client cannot be moved to a different organization — disconnect and reconnect it instead",
        code: "ORG_REBIND_NOT_ALLOWED",
      },
      400,
    );
  }

  const mintCtx = await mintContextFor(ctx, organizationId);
  if (!mintCtx) {
    return c.json(
      { error: "You are not a member of that organization", code: "ORG_NOT_A_MEMBER" },
      403,
    );
  }

  const grants = (body.grants ?? []).filter((g) => g.permissions.length > 0);
  const intent = resolveScopeIntent({
    hasGrants: grants.length > 0,
    fullAccess: body.fullAccess,
  });
  if ("error" in intent) return c.json(intent.error.body, intent.error.status);
  const scoped = intent.scoped;

  // mintCtx, NOT ctx — membership in the target org was already checked above,
  // but grant WIDTH has to be checked there too or it comes from another org.
  const grantErr = await validateGrants(mintCtx, grants);
  if (grantErr) return c.json(grantErr.body, grantErr.status);

  // Widening a live client to unscoped takes effect on its very NEXT request, with
  // no reconnect and no new token — so it is the one direction where a mis-click has
  // an immediate, org-wide consequence. Narrowing needs no confirmation: it can only
  // remove access. Enforced here rather than in the dialog so a script or a curl gets
  // the same gate the dashboard does.
  const previousGrants = existing ? await repos.patGrant.listByToken(existing.id) : [];
  if (mode === "edit" && existing?.scoped && previousGrants.length > 0 && !scoped) {
    if (body.confirmWiden !== true) {
      return c.json(
        {
          error:
            "This removes every restriction on a connected agent, effective immediately. Re-send with confirmWiden to proceed.",
          code: "SCOPE_WIDEN_NOT_CONFIRMED",
        },
        400,
      );
    }
  }

  const binding = await repos.personalAccessToken.upsertOAuthBindingWithGrants({
    userId: ctx.userId,
    organizationId,
    oauthClientId: clientId,
    readOnly: body.readOnly ?? false,
    scoped,
    // A fresh consent IS a new authorization, so it may clear a stale revocation.
    // An edit must never resurrect a binding revoked out from under it.
    unrevoke: mode === "consent",
    grants: grants.map((g) => ({
      resourceType: g.resourceType as ResourceType,
      resourceId: g.resourceId,
      permissions: g.permissions,
      scope: g.scope,
    })),
  });

  // Counts and flags only, never the grant tuples: a full scope dump per edit is
  // unbounded, and a github grant's source scope would put repo paths into a table
  // many roles can read. Matches how `grant.replaced` records a member change.
  audit.recordAsync(auditContextFrom(c, organizationId, ctx.userId), {
    eventType: mode === "edit" ? "mcp.scope_changed" : "mcp.authorized",
    resourceType: "mcp_client",
    resourceId: binding.id,
    before:
      mode === "edit" && existing
        ? { scoped: existing.scoped, readOnly: existing.readOnly, grantCount: previousGrants.length }
        : null,
    after: { clientId, scoped, readOnly: binding.readOnly, grantCount: grants.length },
  });

  return c.json({ data: { ok: true, scoped, readOnly: binding.readOnly } });
}

/**
 * GET /api/tokens/mcp-clients — the caller's connected MCP clients (one per
 * OAuth binding), for the settings management list. Self-scoped to ctx.userId.
 */
/**
 * One shape for a binding, so the list's `grantCount` and the detail's
 * `grants.length` cannot disagree about the same row.
 *
 * Grants are projected to the four fields a client may see. The row `id` and the
 * stubbed `organizationId`/`userId` the pat-grant repo fills in are placeholders,
 * not data, and must not leak. `scope` DOES round-trip — an editor that loads a
 * grant without its source scope and saves it back silently strips the path
 * restriction, which is a live bug in the member-grants panel and must not be
 * reproduced here.
 */
function serializeBinding(
  b: { oauthClientId: string | null; name: string; organizationId: string | null; readOnly: boolean; scoped: boolean; createdAt: Date; lastUsedAt: Date | null },
  name: string,
  organizationName: string | null,
  grants: Array<{ resourceType: string; resourceId: string; permissions: Permission[]; scope?: SourceAccessScope }>,
  opts: { includeGrants: boolean },
) {
  return {
    clientId: b.oauthClientId,
    name,
    organizationId: b.organizationId,
    organizationName,
    readOnly: b.readOnly,
    scoped: b.scoped,
    grantCount: grants.length,
    authorizedAt: b.createdAt,
    lastUsedAt: b.lastUsedAt,
    ...(opts.includeGrants
      ? {
          grants: grants.map((g) => ({
            resourceType: g.resourceType,
            resourceId: g.resourceId,
            permissions: g.permissions,
            ...(g.scope ? { scope: g.scope } : {}),
          })),
        }
      : {}),
  };
}

/**
 * GET /api/tokens/mcp-clients/:clientId — one binding WITH its grants, so the
 * settings editor can prefill.
 *
 * This is the read half the edit flow was missing: `mcp-authorize` has always been
 * an idempotent re-scope, but it replaces grants wholesale with no diff, so an
 * editor that opened without the current scope in hand would overwrite it on save.
 *
 * Resolved through `findOAuthBinding` — the SAME call `resolveBearerIdentity` makes
 * on every request, including its revoked filter — so what the editor shows and what
 * the agent's token resolves to are the same row by construction.
 */
export async function getMcpClient(c: Context) {
  const ctx = getRequestContext(c);
  const clientId = param(c, "clientId").trim();
  if (!clientId) return c.json({ error: "clientId required", code: "CLIENT_ID_REQUIRED" }, 400);

  const binding = await repos.personalAccessToken.findOAuthBinding(ctx.userId, clientId);
  if (!binding) {
    return c.json({ error: "MCP client is not connected", code: "MCP_CLIENT_NOT_CONNECTED" }, 404);
  }

  const [apps, org, grants] = await Promise.all([
    repos.oauth.listApplicationsByClientIds([clientId]),
    binding.organizationId
      ? repos.organization.findManyById([binding.organizationId])
      : Promise.resolve([]),
    repos.patGrant.listByToken(binding.id),
  ]);

  return c.json({
    data: serializeBinding(
      binding,
      apps[0]?.name || binding.name,
      org[0]?.name ?? null,
      grants,
      { includeGrants: true },
    ),
  });
}

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

  // grantCount only — the list renders a count, and shipping every binding's full
  // scope to the settings page is more data than the rows use. The detail route
  // carries the grants.
  const data = bindings.map((b, i) =>
    serializeBinding(
      b,
      // Registered client name; fall back to the binding's stored label.
      (b.oauthClientId && nameByClient.get(b.oauthClientId)) || b.name,
      b.organizationId ? (nameByOrg.get(b.organizationId) ?? null) : null,
      grantsPerBinding[i] ?? [],
      { includeGrants: false },
    ),
  );

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
