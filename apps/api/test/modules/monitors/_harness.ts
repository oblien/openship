/**
 * Real-source E2E harness for the monitors module.
 *
 * Everything here is REAL: the in-memory PGlite DB + `repos` (auto-provisioned
 * by @repo/db under Vitest), the real `projectRoutes` router (real auth +
 * permission + monitor controllers — the monitor routes are nested under
 * /api/projects/:id/monitors), and real `monitor.service`. We only stand up a
 * bare Hono app around the real router (so app.ts's schedulers / startup hooks
 * never fire) and seed rows directly.
 *
 * Auth: a seeded owner + an unscoped PAT sent as `Authorization: Bearer` — the
 * one auth path that works through `app.request()` (zero-auth loopback can't,
 * there's no socket peer). Never send an `Origin` header: F14 rejects bearer
 * tokens from browser-trusted origins.
 */
import "./_env";
import { Hono } from "hono";
import { db, schema, repos } from "@repo/db";
import { mintPatToken } from "../../../src/lib/pat";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${seq++}`;

/** A bare app carrying ONLY the real projects router (no app.ts side effects). */
export function makeApp() {
  const app = new Hono();
  // Same error handler app.ts registers, so thrown permission errors map to
  // their real status (permission.assert throws NotFoundError → 404) instead of
  // Hono's default 500.
  app.onError(handleApiError);
  app.route("/api/projects", projectRoutes);
  return app;
}

export interface SeededOwner {
  userId: string;
  orgId: string;
  token: string;
  auth: Record<string, string>;
}

/** Seed a user + org + owner membership + unscoped PAT. Returns a ready auth
 *  header. Owner role clears project:read/project:write without any grant rows. */
export async function seedOwner(): Promise<SeededOwner> {
  const userId = uid("user");
  const orgId = `org_${userId}`;
  const now = new Date();
  await db.insert(schema.user).values({
    id: userId,
    name: "Owner",
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

/** Seed a minimal project (+ its parent project_app group) in an org — the
 *  parent resource the nested monitor routes hang off. */
export async function seedProject(orgId: string, name = "web"): Promise<string> {
  const groupId = uid("app");
  const id = uid("proj");
  const now = new Date();
  await db.insert(schema.projectGroup).values({
    id: groupId,
    organizationId: orgId,
    name,
    slug: uid("slug"),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.project).values({
    id,
    organizationId: orgId,
    groupId,
    name,
    slug: uid("slug"),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** JSON POST/PATCH/GET/DELETE helper against the app. */
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
  // Root route is mounted at "/api/projects" (no trailing slash — Hono is strict).
  const url = `/api/projects${path === "/" ? "" : path}`;
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

export { db, schema, repos };
