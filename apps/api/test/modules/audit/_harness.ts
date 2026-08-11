/**
 * Real-source E2E harness for the audit module.
 *
 * Everything here is REAL: the in-memory PGlite DB + `repos` (auto-provisioned by
 * @repo/db under Vitest, migrations included — so these tests also prove
 * 0088_audit_source_and_settings applies), the real `auditRoutes` router with its
 * real auth + permission chain, and the real repo-level recording gate. We only
 * stand a bare Hono app around the router so app.ts's schedulers never fire, and
 * seed rows directly.
 *
 * Auth: a seeded owner + an unscoped PAT sent as `Authorization: Bearer` — the
 * one auth path that works through `app.request()` (zero-auth loopback can't,
 * there's no socket peer). Never send an `Origin` header: bearer tokens are
 * rejected from browser-trusted origins.
 */
import "./_env";
import { Hono } from "hono";
import { db, eq, schema, repos } from "@repo/db";
import { mintPatToken } from "../../../src/lib/pat";
import { auditRoutes } from "../../../src/modules/audit/audit.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${seq++}`;

/** A bare app carrying ONLY the real audit router (no app.ts side effects). */
export function makeApp() {
  const app = new Hono();
  // Same error handler app.ts registers, so a thrown permission error maps to its
  // real status instead of Hono's default 500.
  app.onError(handleApiError);
  app.route("/api/audit", auditRoutes);
  return app;
}

export interface SeededOwner {
  userId: string;
  orgId: string;
  token: string;
  auth: Record<string, string>;
}

/** Seed a user + org + owner membership + unscoped PAT. Owner clears
 *  audit:read/audit:write without any grant rows. */
export async function seedOwner(name = "Owner"): Promise<SeededOwner> {
  const userId = uid("user");
  const orgId = `org_${userId}`;
  const now = new Date();
  await db.insert(schema.user).values({
    id: userId,
    name,
    email: `${userId}@test.local`,
    emailVerified: true,
    role: "user",
    autoProvisioned: false,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.organization).values({
    id: orgId,
    name: "Test Org",
    slug: uid("org"),
    createdAt: now,
  });
  await db.insert(schema.member).values({
    id: uid("mem"),
    organizationId: orgId,
    userId,
    role: "owner",
    createdAt: now,
  });
  const pat = mintPatToken();
  await repos.personalAccessToken.create({
    userId,
    organizationId: orgId,
    name: "e2e",
    tokenPrefix: pat.tokenPrefix,
    tokenHash: pat.tokenHash,
    readOnly: false,
    scoped: false,
    expiresAt: null,
  });
  return { userId, orgId, token: pat.token, auth: { Authorization: `Bearer ${pat.token}` } };
}

/** Add a second member to an existing org, with their own PAT. */
export async function seedMember(
  orgId: string,
  role: "admin" | "member",
  name = "Member",
): Promise<SeededOwner> {
  const userId = uid("user");
  const now = new Date();
  await db.insert(schema.user).values({
    id: userId,
    name,
    email: `${userId}@test.local`,
    emailVerified: true,
    role: "user",
    autoProvisioned: false,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.member).values({
    id: uid("mem"),
    organizationId: orgId,
    userId,
    role,
    createdAt: now,
  });
  const pat = mintPatToken();
  await repos.personalAccessToken.create({
    userId,
    organizationId: orgId,
    name: "e2e",
    tokenPrefix: pat.tokenPrefix,
    tokenHash: pat.tokenHash,
    readOnly: false,
    scoped: false,
    expiresAt: null,
  });
  return { userId, orgId, token: pat.token, auth: { Authorization: `Bearer ${pat.token}` } };
}

/**
 * Seed a project (plus the group row it hangs off) so a row's `resourceId` has a
 * name to resolve to — that resolution is what turns "prj_8fk2abc" into
 * "api-gateway" in the feed.
 */
export async function seedProject(orgId: string, name: string): Promise<string> {
  const groupId = uid("app");
  const projectId = uid("proj");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await db.insert(schema.projectGroup).values({ id: groupId, organizationId: orgId, name, slug });
  await db.insert(schema.project).values({
    id: projectId,
    organizationId: orgId,
    groupId,
    name,
    slug,
  });
  return projectId;
}

/**
 * A SCOPED PAT for an existing user, carrying explicit resource grants.
 *
 * A scoped token authenticates as a *restricted* principal regardless of the
 * user's org role, so this is the only way to get a caller that may read the
 * audit log but not change its settings — the case `canManage: false` exists for.
 */
export async function seedScopedToken(
  owner: SeededOwner,
  grants: Array<{ resourceType: string; resourceId: string; permissions: string[] }>,
): Promise<{ token: string; auth: Record<string, string> }> {
  const pat = mintPatToken();
  const row = await repos.personalAccessToken.create({
    userId: owner.userId,
    organizationId: owner.orgId,
    name: "e2e-scoped",
    tokenPrefix: pat.tokenPrefix,
    tokenHash: pat.tokenHash,
    readOnly: false,
    scoped: true,
    expiresAt: null,
  });
  await repos.patGrant.createMany(row.id, grants as never);
  return { token: pat.token, auth: { Authorization: `Bearer ${pat.token}` } };
}

/** The pre-0088 retention location, for the prune's precedence check. */
export async function setOrgRetentionMetadata(orgId: string, days: number | null): Promise<void> {
  await db
    .update(schema.organization)
    .set({ metadata: days === null ? null : JSON.stringify({ auditRetentionDays: days }) })
    .where(eq(schema.organization.id, orgId));
}

export interface SeedEventInput {
  organizationId: string;
  eventType: string;
  actorUserId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  source?: string | null;
  createdAt?: Date;
}

/**
 * Insert an audit row directly.
 *
 * Deliberately NOT through `repos.auditEvent.create` — that path is gated by the
 * recording switch (which is the point of the gate tests) and stamps its own
 * timestamp, and these tests need rows dated into the past.
 */
export async function seedEvent(input: SeedEventInput): Promise<string> {
  const id = uid("aud");
  await db.insert(schema.auditEvent).values({
    id,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? null,
    eventType: input.eventType,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    source: input.source ?? null,
    createdAt: input.createdAt ?? new Date(),
  });
  return id;
}

/** Every audit row for an org, newest first. */
export async function listRaw(orgId: string) {
  const { rows } = await repos.auditEvent.listByOrganization(orgId, { page: 1, perPage: 200 });
  return rows;
}

/** JSON request helper against the app. `path` is relative to /api/audit. */
export async function req(
  app: ReturnType<typeof makeApp>,
  method: string,
  path: string,
  opts: { auth?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { ...(opts.auth ?? {}) };
  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(opts.body);
  }
  // Root is mounted at "/api/audit" — Hono is strict about the trailing slash, so
  // "/" and "/?source=mcp" both have to lose it or they 404.
  const suffix = path === "/" ? "" : path.startsWith("/?") ? path.slice(1) : path;
  const url = `/api/audit${suffix}`;
  const res = await app.request(url, { method, headers, body: payload });
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

export { db, eq, schema, repos };
