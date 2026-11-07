import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { errorReporter, type ErrorEvent } from "@repo/core/diagnostics";
import { currentErrorContext, enrichErrorContext } from "@repo/core/diagnostics/node";
import { observePlatformOperations } from "../../../../packages/platform/src/diagnostics";
import { startCloudTelemetry, stopCloudTelemetry } from "../../src/lib/cloud-telemetry";
import { noteApiError, observeRequestErrors } from "../../src/middleware/error-observation";

// Only the interop runner's isolated, in-memory test database may receive fixture writes.
assert.equal(process.env.NODE_ENV, "test");
assert.notEqual(process.env.OPENSHIP_NATIVE, "true");
for (const key of ["DATABASE_URL", "POSTGRES_HOST", "POSTGRES_PASSWORD", "PGHOST", "PGPASSWORD"])
  assert.ok(!process.env[key], `Unexpected fixture database configuration: ${key}`);
const { db, schema, closeDb } = await import("@repo/db");
const { audit } = await import("../../../../packages/platform/src/engine/lib/audit-emitter");

try {
  await db.insert(schema.user).values({
    id: "fixture-user",
    name: "Interop owner",
    email: "interop@example.test",
    emailVerified: true,
  });
  await db.insert(schema.organization).values({
    id: "fixture-organization",
    name: "Interop workspace",
    slug: "interop-workspace",
  });
  const observations: ErrorEvent[] = [];
  errorReporter.setEnabled(process.env.CLOUD_MODE === "true");
  errorReporter.setSink((events) => {
    observations.push(...events);
  });
  await startCloudTelemetry();
  const ids: string[] = [];
  const operations = observePlatformOperations("deployments", {
    async deploy(
      actor: { organizationId: string; userId: string; traceId: string },
      index: number,
    ) {
      if (index % 10 === 0) throw new Error("Deployment failed password=interop-private-value");
      await audit.record(
        { organizationId: actor.organizationId, actorUserId: actor.userId },
        {
          eventType: "deployment.created",
          resourceType: "deployment",
          resourceId: `fixture-${index}`,
        },
      );
    },
  });
  const app = new Hono();
  app.use("*", observeRequestErrors);
  app.onError((error, context) => {
    noteApiError(context, error);
    return context.json({ error: "Synthetic deployment failed" }, 503);
  });
  app.post("/deployments/:id", async (context) => {
    const actor = {
      userId: "fixture-user",
      organizationId: "fixture-organization",
      traceId: currentErrorContext().traceId!,
    };
    ids.push(actor.traceId);
    context.set("ctx", actor);
    enrichErrorContext(actor);
    await operations.deploy(actor, Number(context.req.param("id")));
    return context.json({ accepted: true });
  });
  const responses = await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      app.request(`/deployments/${index}?token=interop-query-private`, { method: "POST" }),
    ),
  );
  assert.equal(responses.filter((response) => response.status === 503).length, 4);
  assert.equal(responses.filter((response) => response.status === 200).length, 36);
  const audits = await db.select({ id: schema.auditEvent.id }).from(schema.auditEvent);
  assert.equal(audits.length, 36);
  await errorReporter.flush();
  await stopCloudTelemetry();
  await writeFile(
    process.argv[2]!,
    JSON.stringify({
      traces: ids,
      requests: 40,
      failed: 4,
      diagnostics: errorReporter.stats(),
      auditIds: audits.map((event) => event.id),
      observations: observations.map(({ eventId, errorId }) => ({ eventId, errorId })),
    }),
    { mode: 0o600 },
  );
} finally {
  await stopCloudTelemetry();
  await closeDb();
}
