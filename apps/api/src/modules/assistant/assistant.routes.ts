import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ApiError } from "@repo/platform/engine/modules/assistant/native-target";
import { AssistantInputs, ASSISTANT_TURN_MAX_BYTES, type AssistantProvider } from "@repo/contracts";
import type { Static } from "@sinclair/typebox";
import { secureRouter } from "../../lib/secure-router";
import { getRequestContext } from "../../lib/request-context";
import { requestApiPublicUrl } from "@repo/platform/engine/lib/public-url";
import { assistant } from "./assistant.service";
import { assistantAgentRoutes } from "./agents.routes";
import { automationRoutes } from "./automation.routes";
import {
  assistantError,
  requireAssistantSession,
  beginAssistantAuthorization,
  finishAssistantAuthorization,
} from "./assistant-access";

const r = secureRouter(new Hono(), {
  module: "assistant",
  basePath: "/api/assistant",
  mcpExcluded:
    "User-session assistant controls and native agent authentication. Agents use the ordinary /api/mcp endpoint, not recursive assistant tools.",
});
const ctx = getRequestContext;
function provider(c: Context): AssistantProvider {
  const id = c.req.param("provider");
  if (id !== "claude" && id !== "codex") throw assistantError("Unknown agent.", 404);
  return id;
}
async function result(c: Context, work: () => Promise<unknown>) {
  requireAssistantSession(ctx(c));
  c.header("Cache-Control", "no-store");
  try {
    return c.json({ data: await work() });
  } catch (error) {
    if (error instanceof ApiError)
      throw assistantError(
        "Your agent connection could not complete this request. Check AI connections and try again.",
        502,
      );
    throw error;
  }
}
r.get("/status", { tag: "settings:read" }, (c) => result(c, async () => assistant.status(ctx(c))));
r.post("/enable", { tag: "settings:write", body: AssistantInputs.enable }, async (c) =>
  result(c, async () =>
    beginAssistantAuthorization(
      ctx(c),
      requestApiPublicUrl(c.req.raw),
      (await c.req.json()).targetId,
    ),
  ),
);
r.public(
  "get",
  "/callback",
  {
    reason:
      "MCP OAuth client callback; single-use state, PKCE and exact user/workspace binding are checked before opt-in is stored",
    rateLimit: "mcp",
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const redirect = await finishAssistantAuthorization(
      c.req.query("state") ?? "",
      c.req.query("code"),
      c.req.query("error"),
    );
    // Same callback validation and exchange for inline and browser navigation.
    if (c.req.header("accept")?.includes("application/json"))
      return c.json({ data: { enabled: !!c.req.query("code") && !c.req.query("error") } });
    return c.redirect(redirect, 302);
  },
);
r.post("/disable", { tag: "settings:write" }, (c) =>
  result(c, async () => assistant.disable(ctx(c))),
);
r.get("/providers", { tag: "settings:read" }, (c) =>
  result(c, async () => assistant.providers(ctx(c))),
);
r.post("/custom-api", { tag: "settings:write", body: AssistantInputs.customApi }, async (c) =>
  result(c, async () => assistant.customApi(ctx(c), await c.req.json())),
);
r.get("/providers/:provider", { tag: "settings:read" }, (c) =>
  result(c, async () => assistant.provider(ctx(c), provider(c))),
);
r.post(
  "/providers/:provider/auth",
  { tag: "settings:write", body: AssistantInputs.auth },
  async (c) =>
    result(c, async () =>
      assistant.authBegin(
        ctx(c),
        provider(c),
        (await c.req.json<Static<typeof AssistantInputs.auth>>()).method,
      ),
    ),
);
r.post(
  "/providers/:provider/auth/step",
  { tag: "settings:write", body: AssistantInputs.authStep },
  async (c) =>
    result(c, async () =>
      assistant.authStep(
        ctx(c),
        provider(c),
        (await c.req.json<Static<typeof AssistantInputs.authStep>>()).fields,
      ),
    ),
);
r.post("/providers/:provider/logout", { tag: "settings:write" }, (c) =>
  result(c, async () => assistant.logout(ctx(c), provider(c))),
);
r.patch(
  "/providers/:provider",
  { tag: "settings:write", body: AssistantInputs.configure },
  async (c) =>
    result(c, async () =>
      assistant.configure(
        ctx(c),
        provider(c),
        (await c.req.json<Static<typeof AssistantInputs.configure>>()).settings,
      ),
    ),
);
r.get("/conversations", { tag: "settings:read" }, (c) =>
  result(c, async () => assistant.list(ctx(c))),
);
r.post("/conversations", { tag: "settings:write", body: AssistantInputs.create }, async (c) =>
  result(c, async () => assistant.create(ctx(c), await c.req.json())),
);
r.get("/conversations/:id", { tag: "settings:read" }, (c) =>
  result(c, async () => assistant.get(ctx(c), c.req.param("id")!)),
);
r.get("/conversations/:id/history", { tag: "settings:read" }, (c) => {
  const before = c.req.query("before");
  if (!before || before.length > 512) throw assistantError("Invalid history cursor.", 400);
  return result(c, async () => assistant.history(ctx(c), c.req.param("id")!, before));
});
r.delete("/conversations/:id", { tag: "settings:write" }, (c) =>
  result(c, async () => assistant.remove(ctx(c), c.req.param("id")!)),
);
r.use("/conversations/:id/turns", bodyLimit({ maxSize: ASSISTANT_TURN_MAX_BYTES }));
r.post(
  "/conversations/:id/turns",
  { tag: "settings:write", body: AssistantInputs.start },
  async (c) =>
    result(c, async () => assistant.start(ctx(c), c.req.param("id")!, await c.req.json())),
);
r.post(
  "/conversations/:id/activity",
  { tag: "settings:read", body: AssistantInputs.activity, readOnly: true },
  async (c) =>
    result(c, async () =>
      assistant.activity(ctx(c), c.req.param("id")!, await c.req.json(), c.req.raw.signal),
    ),
);
r.post(
  "/conversations/:id/messages",
  { tag: "settings:write", body: AssistantInputs.start },
  async (c) => {
    requireAssistantSession(ctx(c));
    const input = await c.req.json();
    if (input.attachments?.length)
      throw assistantError("Send images after the current turn finishes.", 400);
    return result(c, () => assistant.message(ctx(c), c.req.param("id")!, input));
  },
);
r.post("/conversations/:id/stop", { tag: "settings:write" }, (c) =>
  result(c, async () => assistant.stop(ctx(c), c.req.param("id")!)),
);
r.post(
  "/conversations/:id/respond",
  { tag: "settings:write", body: AssistantInputs.respond },
  async (c) =>
    result(c, async () => assistant.respond(ctx(c), c.req.param("id")!, await c.req.json())),
);
r.hono.route("/agents", assistantAgentRoutes);
r.hono.route("/", automationRoutes);
export const assistantRoutes = r.hono;
