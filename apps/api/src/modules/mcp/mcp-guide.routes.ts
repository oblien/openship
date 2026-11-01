import { Hono } from "hono";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { secureRouter } from "../../lib/secure-router";
import { listPrompts, getPrompt } from "./mcp-prompts";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";

const r = secureRouter(new Hono(), { module: "mcp-guide", basePath: "/api/mcp" });
const guideQuery = Type.Object(
  { name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })) },
  { additionalProperties: false },
);

// The same product guidance is available to tools-only clients (including native
// agents). This reads public documentation only; it never reads account resources.
r.get(
  "/guide",
  {
    tag: "permissions:read",
    authorizationHandledByOperation: true,
    query: guideQuery,
    mcp: {
      description:
        "Discover how OpenShip features work and the tools for each workflow. With no arguments, list available guides; with query.name, read that guide. Start with openship-overview or chat-apps for Slack/Discord/Telegram/Teams control-plane setup. Reuses the MCP prompt catalog; guidance does not grant permissions. Read one relevant guide, then discover only the tools needed and carry out the user's authorized task.",
    },
  },
  async (c) => {
    // Reuse self-discovery's membership and credential-scope checks. Reading a
    // guide requires no resource grants and returns no account/workspace data.
    await operationData(c, getPlatformKernel().permissions.listWorkspaces(operationContext(c)));
    if (!Value.Check(guideQuery, c.req.query()))
      return c.json({ error: "Use a guide name from the available guides." }, 400);
    const name = c.req.query("name");
    if (!name) return c.json({ data: { guides: listPrompts() } });
    const guide = getPrompt(name, {});
    if (!guide) return c.json({ error: "Unknown guide. List available guides first." }, 404);
    return c.json({ data: { name, ...guide } });
  },
);

export const mcpGuideRoutes = r.hono;
