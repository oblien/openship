/** Isolated HTTP/auth fixture: real Better Auth + PGlite, no platform startup jobs. */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { SDK_CAPABILITIES } from "@repo/contracts";

if (
  process.env.NODE_ENV !== "test" ||
  process.env.PGLITE_DATA_DIR !== "memory://" ||
  ["DATABASE_URL", "POSTGRES_HOST", "POSTGRES_PASSWORD", "PGHOST", "PGPASSWORD"].some(
    (key) => process.env[key],
  )
)
  throw new Error("This fixture requires an isolated test database");
// Check isolation before importing any module that can initialize a database.
const { closeDb, db, repos, schema } = await import("@repo/db");
const { auth } = await import("@repo/platform/engine/lib/auth");
const { provisionUser } = await import("@repo/platform/engine/lib/provision-user");
const { internalAuth } = await import("../../src/middleware/internal-auth");
const { authMiddleware } = await import("../../src/middleware/auth");
const { createLocalCliSession } = await import("../../src/modules/system/local-cli.controller");
await provisionUser({
  id: "cli-fixture-admin",
  name: "CLI fixture",
  email: "cli@example.test",
  emailVerified: true,
  role: "admin",
});
const app = new Hono();
app.get("/api/health", (c) => c.json({ sdk: SDK_CAPABILITIES }));
app.post("/api/system/cli-session", internalAuth, createLocalCliSession);
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));
app.get("/api/projects", authMiddleware, (c) =>
  c.json({ data: [], page: 1, perPage: 50, total: 0 }),
);
app.get("/api/test-authority", authMiddleware, (c) => {
  const ctx = c.get("ctx");
  return c.json({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    sessionId: ctx.sessionId,
    sessionKind: ctx.sessionKind,
  });
});
app.get("/api/test-session-count", internalAuth, async (c) => {
  return c.json({ count: await repos.session.countByUser("cli-fixture-admin") });
});
app.post("/api/test-expire-sessions", internalAuth, async (c) => {
  await db.update(schema.session).set({ expiresAt: new Date(0) });
  return c.json({ success: true });
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
  process.send?.({ port: info.port }),
);
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => {
    void closeDb().finally(() => process.exit(0));
  });
});
