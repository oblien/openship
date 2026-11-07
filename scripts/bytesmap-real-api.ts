import assert from "node:assert/strict";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { createDatabase, schema, sql } from "@repo/db/factory";
import {
  freePort,
  startApi,
  stopApi,
  type RunningApi,
} from "../apps/api/test/e2e/fixtures/instance-api";

/** Owned credentials and metadata; real built API, Better Auth, authorization and operation code. */
export async function exerciseBytesMapApi(
  directory: string,
  root: string,
  environment: Record<string, string>,
) {
  const dbDir = join(directory, "real-api-data");
  const password = "only-owned-interop-password-932!";
  const email = "bytesmap-interop@example.test";
  const userId = "bytesmap-interop-user";
  const organizationId = "org_bytesmap-interop-user";
  const database = await createDatabase({
    driver: "pglite",
    dataDir: dbDir,
    migrationsDir: join(root, "packages/db/drizzle"),
  });
  try {
    await database.db
      .insert(schema.user)
      .values({ id: userId, name: "Interop owner", email, emailVerified: true });
    await database.db
      .insert(schema.account)
      .values({
        id: "interop-credential",
        userId,
        accountId: userId,
        providerId: "credential",
        password: await hashPassword(password),
      });
    await database.db
      .insert(schema.organization)
      .values({ id: organizationId, name: "Owned interop workspace", slug: organizationId });
    await database.db
      .insert(schema.member)
      .values({ id: "interop-membership", userId, organizationId, role: "owner" });
  } finally {
    await database.close();
  }
  let api: RunningApi | undefined;
  const requests: {
    name: string;
    traceId: string;
    parentSpanId: string;
    requestId: string;
    status: number;
  }[] = [];
  try {
    api = await startApi({
      dbDir,
      port: await freePort(),
      secret: "owned-bytesmap-interop-secret-00000000000000",
      authMode: "local",
      cloudMode: true,
      runtime: "node",
      entry: join(root, "apps/cli/dist/server/index.js"),
      environment: {
        ...environment,
        OPENSHIP_REQUIRE_REDIS: "false",
        OPENSHIP_MIGRATIONS_DIR: join(root, "apps/cli/dist/server/migrations"),
        OPENSHIP_PGLITE_ASSETS_DIR: join(root, "apps/cli/dist/server/pglite"),
      },
    });
    const active = api;
    async function request(name: string, path: string, status: number, init: RequestInit = {}) {
      const traceId = randomBytes(16).toString("hex");
      const parentSpanId = randomBytes(8).toString("hex");
      const response = await fetch(active.baseUrl + path, {
        ...init,
        headers: {
          "content-type": "application/json",
          origin: active.baseUrl,
          "user-agent": "owned-bytesmap-integration",
          ...init.headers,
          traceparent: `00-${traceId}-${parentSpanId}-01`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, status, `${name}: ${await response.clone().text()}`);
      const requestId = response.headers.get("x-request-id");
      assert.ok(requestId);
      requests.push({ name, traceId, parentSpanId, requestId, status });
      return response;
    }
    await request("unauthenticated", "/api/projects", 401);
    const signedIn = await request("sign-in", "/api/auth/sign-in/email", 200, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    assert.ok(cookie);
    const authenticated = { cookie, "x-organization-id": organizationId };
    const started = performance.now();
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        request(`projects.list.${index}`, "/api/projects", 200, { headers: authenticated }),
      ),
    );
    const durationMs = performance.now() - started;
    await request("project-not-found", "/api/projects/owned-missing-project", 404, {
      headers: authenticated,
    });
    await request("invalid-project", "/api/projects", 400, {
      method: "POST",
      headers: authenticated,
      body: "{}",
    });
    await request("browser-exception", "/api/diagnostics/client-errors", 204, {
      method: "POST",
      body: JSON.stringify({
        events: [
          {
            name: "Error",
            message: "password=real-api-private-value",
            component: "dashboard/hooks/useBuildConnection",
            page: "/projects/private-project?token=real-api-query-secret",
            eventId: "owned-browser-exception",
          },
        ],
      }),
    });
    await stopApi(api);
    assert.equal(api.child.exitCode, 0, `Built API did not shut down cleanly: ${api.logs()}`);
    const persisted = await createDatabase({ driver: "pglite", dataDir: dbDir });
    try {
      const rows = await persisted.db.execute(sql`SELECT event FROM cloud_error_event`);
      const errors = rows.rows.map((row) => (row as { event: any }).event);
      const client = errors.find(
        (event) => event.context.clientEventId === "owned-browser-exception",
      );
      assert.ok(client, "Real browser exception was not stored in OpenShip");
      assert.equal(client.context.untrusted, true);
      assert.ok(!JSON.stringify(errors).includes("real-api-private-value"));
      assert.ok(!JSON.stringify(errors).includes("real-api-query-secret"));
      assert.equal(new Set(errors.map((event) => event.eventId)).size, errors.length);
      return {
        requests,
        organizationId,
        userId,
        browserObservationId: client.eventId,
        concurrentRequests: 16,
        durationMs,
        persistedErrorObservations: errors.length,
      };
    } finally {
      await persisted.close();
    }
  } finally {
    if (api) await stopApi(api);
  }
}
