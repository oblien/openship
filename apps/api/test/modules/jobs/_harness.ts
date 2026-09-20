/**
 * Real-source E2E harness for the jobs module.
 *
 * Everything here is REAL: the in-memory PGlite DB + `repos` (auto-provisioned
 * by @repo/db under Vitest), the real `jobRoutes` router (real auth +
 * permission + controllers), and real `job.service` / `job-command`. We only
 * stand up a bare Hono app around the real router (so app.ts's schedulers /
 * startup hooks never fire) and seed rows directly.
 *
 * Auth: a seeded owner + an unscoped PAT sent as `Authorization: Bearer` — the
 * one auth path that works through `app.request()` (zero-auth loopback can't,
 * there's no socket peer). Never send an `Origin` header: F14 rejects bearer
 * tokens from browser-trusted origins.
 */
import "./_env";
import { Hono } from "hono";
import { db, schema, repos } from "@repo/db";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { jobRoutes } from "../../../src/modules/jobs/job.routes";
import { setJobRunnerForTests } from "@repo/platform/engine/lib/job-runner/index";
import { handleApiError } from "../../../src/middleware/error-handler";

/**
 * Swap the job-runner singleton for a fake that just records cron
 * registrations — so `createCustomJob`/`reconcileJobs`'s `syncJob` never
 * constructs the real in-process runner (which would arm real poll timers) and
 * scheduling tests can assert registration + drive ticks deterministically.
 */
export function installFakeRunner() {
  const recurring = new Map<string, () => Promise<void> | void>();
  const fake = {
    name: "in-process" as const,
    async start() {},
    async shutdown() {},
    async enqueueRun() {},
    scheduleRecurring(opts: { jobId: string; cronExpression: string; onTick: () => Promise<void> | void }) {
      recurring.set(opts.jobId, opts.onTick);
    },
    removeRecurring(jobId: string) {
      recurring.delete(jobId);
    },
    describe() {
      return { name: "in-process" as const, registered: [...recurring.keys()] };
    },
  };
  setJobRunnerForTests(fake as never);
  /** Fire a registered job's cron tick by key (deterministic, no wall clock). */
  const tick = (jobId: string) => recurring.get(jobId)?.();
  return { recurring, tick };
}

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${seq++}`;

/** A bare app carrying ONLY the real jobs router (no app.ts side effects). */
export function makeApp() {
  const app = new Hono();
  // Same error handler app.ts registers, so thrown permission errors map to
  // their real status (permission.assert throws NotFoundError → 404) instead of
  // Hono's default 500.
  app.onError(handleApiError);
  app.route("/api/jobs", jobRoutes);
  return app;
}

export interface SeededOwner {
  userId: string;
  orgId: string;
  token: string;
  auth: Record<string, string>;
}

/** Seed a user + org + owner membership + unscoped PAT. Returns a ready auth
 *  header. Owner role clears job:read/job:write without any grant rows. */
export async function seedOwner(opts: { instanceAdmin?: boolean; bound?: boolean } = {}): Promise<SeededOwner> {
  const userId = uid("user");
  const orgId = `org_${userId}`;
  const now = new Date();
  await db.insert(schema.user).values({
    id: userId,
    name: "Owner",
    email: `${userId}@test.local`,
    emailVerified: true,
    role: opts.instanceAdmin ? "admin" : "user",
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
    organizationId: (opts.bound ?? !opts.instanceAdmin) ? orgId : null,
    name: "e2e",
    tokenPrefix: pat.tokenPrefix,
    tokenHash: pat.tokenHash,
    readOnly: false,
    scoped: false,
    expiresAt: null,
  });
  return { userId, orgId, token: pat.token, auth: { Authorization: `Bearer ${pat.token}` } };
}

/** Seed a server row in an org (the target a command job runs on). */
export async function seedServer(orgId: string, name = "srv"): Promise<string> {
  const id = uid("server");
  const now = new Date();
  await db.insert(schema.servers).values({
    id,
    organizationId: orgId,
    name,
    sshHost: "10.0.0.1",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** Wipe jobs + runs between tests (they're instance-global; list returns all). */
export async function resetJobs(): Promise<void> {
  await db.delete(schema.jobRun);
  await db.delete(schema.job);
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
  // Root route is mounted at "/api/jobs" (no trailing slash — Hono is strict).
  const url = `/api/jobs${path === "/" ? "" : path}`;
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
