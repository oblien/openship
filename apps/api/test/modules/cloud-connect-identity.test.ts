import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { db, repos, schema, eq, and } from "@repo/db";
import { seedOwner, installFakeRunner, type SeededOwner } from "./jobs/_harness";
import { auth } from "@repo/platform/engine/lib/auth";
import { cloudRuntimeTarget } from "@repo/platform/engine/config/env";
import {
  storeCloudSession,
  getCloudConnectionStatusForOrg,
} from "@repo/platform/engine/lib/cloud/session";
import { cloudFetch, readCloudSession } from "@repo/platform/engine/lib/cloud/transport";
import { cloudSaasRoutes } from "../../src/modules/cloud/cloud-saas.routes";
import { cloudSupportRoutes } from "../../src/modules/cloud-support/cloud-support.routes";
import { permissionsRoutes } from "../../src/modules/permissions/permissions.routes";
import { handleApiError } from "../../src/middleware/error-handler";
import { shutdownRateLimit } from "../../src/lib/rate-limit";

vi.mock("@repo/platform/engine/config/env", async (original) => {
  const config = await original<typeof import("@repo/platform/engine/config/env")>();
  return { ...config, env: { ...config.env, CLOUD_MODE: true } };
});

installFakeRunner();
let legacy = false;
let local: SeededOwner;
let cloud: SeededOwner;
let token: string;
let sessionId: string;
const requests: Array<{ path: string; organizationId: string | null }> = [];
const app = new Hono()
  .onError(handleApiError)
  .use("/api/cloud/support/*", async (c, next) => {
    // The real API's proxy middleware supplies this before the intake limiter.
    c.set("clientIp", "192.0.2.10");
    await next();
  })
  .use("/api/cloud/account", async (c, next) => {
    await next();
    if (legacy && c.res.status === 200) {
      // v0.8.0's account response exposed the profile, without identity IDs.
      // Authentication and organization resolution still run through real routes.
      const body = await c.res.json();
      delete body.user.id;
      delete body.user.organizationId;
      c.res = c.json(body);
    }
  })
  .route("/api/cloud", cloudSaasRoutes)
  .route("/api/cloud/support", cloudSupportRoutes)
  .route("/api/permissions", permissionsRoutes)
  .get("/api/auth/get-session", (c) => auth.handler(c.req.raw));

beforeAll(() => vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory"));
afterAll(async () => {
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  legacy = false;
  requests.length = 0;
  local = await seedOwner();
  cloud = await seedOwner();
  token = `cloud-session-${randomUUID()}`;
  sessionId = `sess_link_${randomUUID()}`;
  await db.insert(schema.session).values({
    id: sessionId,
    token,
    userId: cloud.userId,
    activeOrganizationId: cloud.orgId,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== new URL(cloudRuntimeTarget.api).origin)
      throw new Error("Unexpected Cloud destination");
    requests.push({
      path: url.pathname,
      organizationId: new Headers(init?.headers).get("X-Organization-Id"),
    });
    return app.request(url.href, init);
  });
});

describe("Cloud connection across account API versions", () => {
  it("authenticates the real linked session for private support, without accepting a PAT", async () => {
    await storeCloudSession(local.userId, token);
    const response = await cloudFetch(local.userId, "/api/cloud/support/session");
    expect(response?.status, await response?.clone().text()).toBe(200);
    expect((await response!.json()).account).toMatchObject({ id: cloud.userId, key: cloud.userId });
    const inbox = await cloudFetch(local.userId, "/api/cloud/support/mine");
    expect(inbox?.status).toBe(200);
    expect(await inbox!.json()).toEqual({ tickets: [], nextCursor: null });
    const rejected = await app.request("/api/cloud/support/session", { headers: cloud.auth });
    expect(rejected.status).toBe(403);
    expect((await rejected.json()).code).toBe("SUPPORT_SESSION_REQUIRED");
  });
  it.each([false, true])(
    "connects and verifies the server-authenticated identity (legacy profile: %s)",
    async (older) => {
      legacy = older;
      await storeCloudSession(local.userId, token);
      expect(await readCloudSession(local.userId)).toMatchObject({
        apiUrl: cloudRuntimeTarget.api,
        userId: cloud.userId,
        organizationId: cloud.orgId,
        token,
      });
      expect(await getCloudConnectionStatusForOrg(local.orgId)).toMatchObject({
        connected: true,
        user: { id: cloud.userId, organizationId: cloud.orgId },
      });
      if (!older)
        expect(requests.map((request) => request.path)).toEqual([
          "/api/cloud/account",
          "/api/cloud/account",
        ]);
      else expect(requests.map((request) => request.path)).toContain("/api/permissions/org-meta");
    },
  );

  it.each([false, true])(
    "keeps the verified workspace pinned when Cloud changes active workspace (legacy: %s)",
    async (older) => {
      legacy = older;
      await storeCloudSession(local.userId, token);
      const other = await seedOwner();
      await db.insert(schema.member).values({
        id: randomUUID(),
        userId: cloud.userId,
        organizationId: other.orgId,
        role: "owner",
        createdAt: new Date(),
      });
      await db
        .update(schema.session)
        .set({ activeOrganizationId: other.orgId })
        .where(eq(schema.session.id, sessionId));
      requests.length = 0;
      expect(await getCloudConnectionStatusForOrg(local.orgId)).toMatchObject({
        connected: true,
        user: { id: cloud.userId, organizationId: cloud.orgId },
      });
      expect(requests.every((request) => request.organizationId === cloud.orgId)).toBe(true);
    },
  );

  it.each([false, true])(
    "refuses a connection after membership in the pinned workspace is removed (legacy: %s)",
    async (older) => {
      legacy = older;
      await storeCloudSession(local.userId, token);
      await db
        .delete(schema.member)
        .where(
          and(
            eq(schema.member.userId, cloud.userId),
            eq(schema.member.organizationId, cloud.orgId),
          ),
        );
      expect(await getCloudConnectionStatusForOrg(local.orgId)).toEqual({ connected: false });
      expect(await readCloudSession(local.userId)).toBeNull();
    },
  );

  it("preserves a working connection when a replacement credential is expired", async () => {
    await storeCloudSession(local.userId, token);
    const existing = (await repos.settings.findByUser(local.userId))!.cloudSessionToken;
    await expect(storeCloudSession(local.userId, "invalid-cloud-session")).rejects.toMatchObject({
      statusCode: 401,
    });
    expect((await repos.settings.findByUser(local.userId))!.cloudSessionToken).toBe(existing);
  });
});
