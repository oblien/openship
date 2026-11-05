import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";

// The zero-auth gate (loopback + desktop posture) is exercised by
// test/middleware/zero-auth-guard.test.ts. Here we want the bootstrap path
// itself, so pretend the gate passed.
vi.mock("@/middleware/zero-auth-guard", () => ({
  zeroAuthAllowed: async () => ({ ok: true as const }),
}));

import { closeDb, db, eq, schema } from "@repo/db";
import { provisionUser } from "@repo/platform/engine/lib/provision-user";
import { ensureLocalUser } from "@/lib/local-user";
import { mintSession } from "@/lib/cloud-auth-proxy";
import { getSession } from "@/modules/auth/auth.controller";

afterAll(() => closeDb());

async function seedCloudUser(): Promise<string> {
  const id = randomUUID();
  await provisionUser({
    id,
    email: `${id}@cloud.test`,
    name: "Cloud User",
    emailVerified: true,
    role: "admin",
  });
  return id;
}

function callGetSession() {
  // No session cookie — e.g. an auto-update wiped the cookie store.
  return new Hono().get("/get-session", getSession).request("/get-session");
}

describe("get-session zero-auth bootstrap (#1612)", () => {
  it("keeps the operator's identity when another user still has unexpired sessions", async () => {
    await db.delete(schema.session);
    const local = await ensureLocalUser();
    const cloudUserId = await seedCloudUser();
    await mintSession({ purpose: "local-cookie", userId: cloudUserId });

    const res = await callGetSession();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.userId).toBe(cloudUserId);
    expect(body.user.id).toBe(cloudUserId);
    expect(body.user.id).not.toBe(local.id);
    expect(res.headers.get("set-cookie")).toContain("openship.session_token");
  });

  it("still bootstraps the Local User when no other user has sessions", async () => {
    await db.delete(schema.session);
    const local = await ensureLocalUser();
    await seedCloudUser(); // user exists, but has never signed in

    const res = await callGetSession();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.userId).toBe(local.id);
    expect(body.user.id).toBe(local.id);
  });

  it("ignores expired sessions of other users", async () => {
    await db.delete(schema.session);
    const local = await ensureLocalUser();
    const cloudUserId = await seedCloudUser();
    await mintSession({ purpose: "local-cookie", userId: cloudUserId });
    await db
      .update(schema.session)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.session.userId, cloudUserId));

    const res = await callGetSession();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.userId).toBe(local.id);
    expect(body.user.id).toBe(local.id);
  });
});
