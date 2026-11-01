import { ErrorEvent } from "@repo/core/diagnostics";
import { createDatabase, sql } from "@repo/db/factory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freePort,
  startApi,
  stopApi,
  type RunningApi,
} from "./fixtures/instance-api";

let api: RunningApi;
let directory: string;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function events(): ErrorEvent[] {
  return api
    .logs()
    .split("\n")
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.schemaVersion === 1 && event.eventId ? [event] : [];
      } catch {
        return [];
      }
    });
}

async function reported(requestId: string | null, kind = "http") {
  for (let attempt = 0; attempt < 100; attempt++) {
    const event = events().find(
      (event) =>
        event.context.requestId === requestId && event.context.kind === kind,
    );
    if (event) return event;
    await delay(25);
  }
  throw new Error(`Missing ${kind} diagnostic for request ${requestId}`);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openship-diagnostics-e2e-"));
  api = await startApi({
    dbDir: directory,
    port: await freePort(),
    authMode: "local",
    cloudMode: true,
    environment: { OPENSHIP_REQUIRE_REDIS: "false" },
    secret: "diagnostics-e2e-local-secret-not-a-customer-secret",
  });
});
afterAll(async () => {
  if (api) await stopApi(api);
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("real Cloud API diagnostics without provider or host access", () => {
  it("boots with the route gate and records unauthenticated failures with a response reference", async () => {
    const response = await fetch(`${api.baseUrl}/api/projects`);
    expect(response.status).toBe(401);
    const event = await reported(response.headers.get("X-Request-ID"));
    expect(event).toMatchObject({
      category: "authentication",
      context: { statusCode: 401, method: "GET" },
    });
    expect(event.context.userId).toBeUndefined();
  });

  it("accepts pre-auth browser failures as untrusted and redacts secrets again", async () => {
    const response = await fetch(
      `${api.baseUrl}/api/diagnostics/client-errors`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              name: "Error",
              message: "password=private-client-913",
              component: "dashboard/hooks/useBuildConnection",
              page: "/accept-invite/private-invitation-913?token=private-query-913",
              eventId: "client-event-1",
            },
          ],
        }),
      },
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const event = await reported(
      response.headers.get("X-Request-ID"),
      "client",
    );
    expect(event).toMatchObject({
      severity: "warn",
      context: {
        source: "dashboard",
        component: "dashboard/hooks/useBuildConnection",
        untrusted: true,
        clientEventId: "client-event-1",
      },
    });
    expect(event.errorId).not.toBe("client-event-1");
    expect(event.context.userId).toBeUndefined();
    expect(event.context.organizationId).toBeUndefined();
    expect(JSON.stringify(event)).not.toMatch(
      /private-(client|invitation|query)-913/,
    );
  });

  it("rejects forged identities and malformed input without changing normal API operation", async () => {
    const headers = { "Content-Type": "application/json" };
    const forged = await fetch(`${api.baseUrl}/api/diagnostics/client-errors`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        events: [
          {
            name: "Error",
            message: "forged",
            organizationId: "victim",
            userId: "admin",
            severity: "fatal",
          },
        ],
      }),
    });
    expect(forged.status).toBe(400);
    expect(
      (await reported(forged.headers.get("X-Request-ID"))).context
        .organizationId,
    ).toBeUndefined();
    const malformed = await fetch(
      `${api.baseUrl}/api/diagnostics/client-errors`,
      { method: "POST", headers, body: "{" },
    );
    expect(malformed.status).toBe(400);
    expect(
      (await reported(malformed.headers.get("X-Request-ID"))).category,
    ).toBe("validation");
    for (const component of ["", "a".repeat(161)]) {
      const invalidComponent = await fetch(
        `${api.baseUrl}/api/diagnostics/client-errors`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            events: [{ name: "Error", message: "invalid module", component }],
          }),
        },
      );
      expect(invalidComponent.status).toBe(400);
    }
    expect((await fetch(`${api.baseUrl}/api/health`)).status).toBe(200);
  });

  it("bounds payload size and rate even when the sender connects over loopback", async () => {
    const headers = { "Content-Type": "application/json" };
    const large = await fetch(`${api.baseUrl}/api/diagnostics/client-errors`, {
      method: "POST",
      headers,
      body: " ".repeat(70_000),
    });
    expect(large.status).toBe(413);
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const response = await fetch(
        `${api.baseUrl}/api/diagnostics/client-errors`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            events: [{ name: "Error", message: "bounded" }],
          }),
        },
      );
      statuses.push(response.status);
      if (response.status === 429)
        expect(response.headers.get("Retry-After")).toBeTruthy();
    }
    expect(statuses).toContain(429);
    expect((await fetch(`${api.baseUrl}/api/health`)).status).toBe(200);
  });

  it("persists the Cloud events before shutdown closes the database", async () => {
    // A real file-backed PGlite has one owner; inspect only after the API exits.
    await stopApi(api);
    const connection = await createDatabase({ driver: "pglite", dataDir: directory });
    try {
      const result = await connection.db.execute(sql`SELECT event FROM cloud_error_event`);
      const persisted = result.rows.map((row) => (row as { event: ErrorEvent }).event);
      const client = persisted.find((event) => event.context.clientEventId === "client-event-1");
      expect(client).toMatchObject({ context: { untrusted: true, source: "dashboard" } });
      expect(persisted.some((event) => event.category === "authentication")).toBe(true);
      expect(JSON.stringify(persisted)).not.toMatch(/private-(client|invitation|query)-913/);
      expect(new Set(persisted.map((event) => event.eventId)).size).toBe(persisted.length);
    } finally {
      await connection.close();
    }
  });
});

it.each(["local", "none"] as const)(
  "leaves diagnostics disabled on a non-Cloud API (auth: %s)",
  async (authMode) => {
    const dbDir = await mkdtemp(join(tmpdir(), "openship-private-diagnostics-e2e-"));
    let local: RunningApi | undefined;
    try {
      local = await startApi({
        dbDir,
        authMode,
        port: await freePort(),
        secret: "private-instance-e2e-0000000000000000000",
      });
      const response = await fetch(`${local.baseUrl}/api/nonexistent-private-913`);
      expect([401, 404]).toContain(response.status);
      expect(response.headers.get("X-Request-ID")).toBeTruthy();
      const intake = await fetch(`${local.baseUrl}/api/diagnostics/client-errors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: [{ name: "Error", message: "private-client-913" }] }),
      });
      expect(intake.status).toBe(404);
      await stopApi(local);
      expect(local.logs()).not.toContain('"kind":"http"');
      expect(local.logs()).not.toContain('"kind":"client"');
      const connection = await createDatabase({ driver: "pglite", dataDir: dbDir });
      try {
        const table = await connection.db.execute(
          sql`SELECT to_regclass('cloud_error_event') AS name`,
        );
        expect(table.rows[0]).toEqual({ name: null });
      } finally {
        await connection.close();
      }
    } finally {
      if (local) await stopApi(local);
      await rm(dbDir, { recursive: true, force: true });
    }
  },
);
