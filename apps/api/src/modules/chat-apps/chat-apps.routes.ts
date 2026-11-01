import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  ChatAppInputs,
  chatAppSetup,
  type ChatAppProvider,
  type ChatAppPurpose,
  type ChatAppTransport,
} from "@repo/contracts";
import { AppError } from "@repo/core";
import { Value } from "@sinclair/typebox/value";
import { secureRouter } from "../../lib/secure-router";
import { getRequestContext } from "../../lib/request-context";
import {
  requestApiPublicUrl,
  resolveDashboardPublicUrl,
} from "@repo/platform/engine/lib/public-url";
import { chatApps } from "./chat-apps.service";
import { beginPairing, completePairing } from "./chat-apps-access";
const r = secureRouter(new Hono(), {
  module: "chat-apps",
  basePath: "/api/chat-apps",
  mcpExcluded:
    "Bot credentials, connector changes and account consent require the user's session. Agents may inspect scoped connection status and prepare setup guidance.",
});
r.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
r.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});
r.get(
  "/",
  {
    tag: "settings:read",
    mcp: {
      description:
        "List this workspace's chat-app connections: Slack, Discord, Telegram and Teams. Returns bot roles (assistant, deployment commands, or both), connection status and this user's account-link status, without credentials. Use for chat control-plane setup and troubleshooting; these are separate from outbound notification channels. Requires settings read access. To connect a new bot, use get_chat_apps_setup.",
    },
  },
  async (c) => c.json({ data: await chatApps.status(getRequestContext(c)) }),
);
r.get(
  "/setup",
  {
    tag: "settings:read",
    query: ChatAppInputs.setup,
    mcp: {
      description:
        "Prepare the existing chat-app connection form for Slack, Discord, Telegram or Teams. Supply query.provider, and purpose='commands' for the deployment control plane, 'assistant' for AI chat, or 'both'. Returns setup guidance and an inline Connect button; creates nothing and grants no access. Bot tokens are entered privately in that form, never in chat. Slack/Discord/Telegram default to outbound (no public URL); Teams requires webhook HTTPS. Deployment commands need no Mindwire or AI. Each sender must complete their own normal account consent.",
    },
  },
  (c) => {
    if (!Value.Check(ChatAppInputs.setup, c.req.query()))
      throw new AppError(
        "Choose a supported chat app, bot role and connection method.",
        400,
        "CHAT_APPS_ERROR",
      );
    const provider = c.req.query("provider") as ChatAppProvider;
    const purpose = c.req.query("purpose") as ChatAppPurpose | undefined;
    const transport = c.req.query("transport") as ChatAppTransport | undefined;
    if (provider === "teams" && transport === "outbound")
      throw new AppError(
        "Microsoft Teams requires a public HTTPS webhook endpoint.",
        400,
        "CHAT_APPS_ERROR",
      );
    const setup = chatAppSetup(provider, purpose, transport);
    const organizationId = getRequestContext(c).organizationId;
    return c.json({
      data: {
        ...setup,
        organizationId,
        setupPath: `${setup.setupPath}&organizationId=${encodeURIComponent(organizationId)}`,
      },
    });
  },
);
r.post("/", { tag: "settings:write", body: ChatAppInputs.create }, async (c) =>
  c.json({
    data: await chatApps.create(
      getRequestContext(c),
      requestApiPublicUrl(c.req.raw),
      await c.req.json(),
    ),
  }),
);
r.get("/:id/configuration", { tag: "settings:read" }, async (c) =>
  c.json({ data: await chatApps.configuration(getRequestContext(c), c.req.param("id")!) }),
);
r.put(
  "/:id/configuration",
  { tag: "settings:write", body: ChatAppInputs.configuration },
  async (c) =>
    c.json({
      data: await chatApps.configure(getRequestContext(c), c.req.param("id")!, await c.req.json()),
    }),
);
r.patch("/:id", { tag: "settings:write", body: ChatAppInputs.enable }, async (c) => {
  const input = await c.req.json();
  return c.json({
    data: await chatApps.setEnabled(
      getRequestContext(c),
      c.req.param("id")!,
      input.enabled,
      input.revision,
    ),
  });
});
r.post("/:id/commands/sync", { tag: "settings:write", body: ChatAppInputs.commands }, async (c) => {
  const input = await c.req.json();
  return c.json({
    data: await chatApps.syncCommands(getRequestContext(c), c.req.param("id")!, input.revision),
  });
});
r.delete("/:id", { tag: "settings:write" }, async (c) => {
  await chatApps.remove(getRequestContext(c), c.req.param("id")!);
  return c.json({ success: true });
});
r.patch("/:id/purpose", { tag: "settings:write", body: ChatAppInputs.purpose }, async (c) => {
  const input = await c.req.json();
  return c.json({
    data: await chatApps.setPurpose(
      getRequestContext(c),
      c.req.param("id")!,
      input.purpose,
      input.revision,
    ),
  });
});
r.patch(
  "/:id/assistant-policy",
  { tag: "settings:write", body: ChatAppInputs.enable },
  async (c) => {
    const input = await c.req.json();
    return c.json({
      data: await chatApps.setAssistantAllowed(
        getRequestContext(c),
        c.req.param("id")!,
        input.enabled,
        input.revision,
      ),
    });
  },
);
r.put("/:id/assistant", { tag: "settings:write", body: ChatAppInputs.assistant }, async (c) =>
  c.json({
    data: await chatApps.configureAssistant(
      getRequestContext(c),
      c.req.param("id")!,
      await c.req.json(),
    ),
  }),
);
r.post("/:id/unlink", { tag: "settings:write" }, async (c) => {
  await chatApps.unlink(getRequestContext(c), c.req.param("id")!);
  return c.json({ success: true });
});
r.post("/pairing", { tag: "settings:write", body: ChatAppInputs.pair }, async (c) =>
  c.json({ data: await beginPairing(getRequestContext(c), (await c.req.json()).challenge) }),
);
r.post("/pairing/complete", { tag: "settings:write", body: ChatAppInputs.complete }, async (c) => {
  const input = await c.req.json();
  return c.json({ data: await completePairing(getRequestContext(c), input.state, input.code) });
});
r.public(
  "get",
  "/callback",
  {
    reason:
      "Fixed OAuth redirect only; session-bound code exchange and sender verification happen separately",
    rateLimit: "mcp",
  },
  (c) => {
    const url = new URL("/settings", resolveDashboardPublicUrl());
    url.searchParams.set("tab", "chat-apps");
    for (const key of ["state", "code", "error"])
      if (c.req.query(key)) url.searchParams.set(key, c.req.query(key)!);
    return c.redirect(url.toString(), 302);
  },
);
r.public(
  "post",
  "/webhooks/:id",
  {
    reason: "Provider-signed webhook, verified from raw bytes before encrypted enqueueing",
    rateLimit: "webhook-ingress",
  },
  async (c) => {
    if (c.req.header("origin")) return c.body(null, 403);
    const headers: Record<string, string> = {};
    for (const key of [
      "content-type",
      "authorization",
      "x-slack-signature",
      "x-slack-request-timestamp",
      "x-signature-ed25519",
      "x-signature-timestamp",
      "x-telegram-bot-api-secret-token",
    ]) {
      const value = c.req.header(key);
      if (value) headers[key] = value;
    }
    const result = await chatApps.forward(c.req.param("id")!, await c.req.text(), headers);
    return new Response(result.body, {
      status: result.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  },
);
export const chatAppRoutes = r.hono;
