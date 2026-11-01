import { Hono } from "hono";
import { Type } from "@sinclair/typebox";
import { AssistantAgentCreate, AssistantAgentEdit, AssistantAgentTaskInput } from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import { getRequestContext as ctx } from "../../lib/request-context";
import { assistantAgents as agents } from "./agents.service";
const r = secureRouter(new Hono(), {
  module: "assistant-agents",
  basePath: "/api/assistant/agents",
});
r.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
r.get(
  "/",
  {
    tag: "settings:read",
    mcp: {
      description:
        "List your saved specialist agents and their task conversations in this workspace. Agents perform specific scoped tasks and can be selected by automations. The general OpenShip assistant remains separate. Native provider credentials are never returned.",
    },
  },
  async (c) => c.json({ data: await agents.list(ctx(c)) }),
);
r.post(
  "/",
  {
    tag: "settings:write",
    body: AssistantAgentCreate,
    mcp: {
      description:
        "Create a saved scoped specialist using the normal agent API. Set its purpose, instructions, provider/model, readOnly and concrete resource grants, all within your current access. Reuse requestId on retries. This creates no task or schedule; delegate a task or attach an automation separately. Agents cannot manage credentials, create other agents or expand their permissions.",
    },
  },
  async (c) => {
    const { requestId, ...input } = await c.req.json();
    return c.json({ data: await agents.save(ctx(c), input, { requestId }) });
  },
);
r.get(
  "/:id",
  {
    tag: "settings:read",
    mcp: {
      description:
        "Read a specialist's saved instructions, resource scope and task history before using or editing it.",
    },
  },
  async (c) => c.json({ data: await agents.get(ctx(c), c.req.param("id")!) }),
);
r.put(
  "/:id",
  {
    tag: "settings:write",
    body: AssistantAgentEdit,
    mcp: {
      description:
        "Update a specialist's identity, icon, instructions, model or scoped permissions using its current revision. Work-setting changes revoke old task access and pause attached automations for review. Changing only the icon preserves conversations and automations. Access cannot exceed yours or the connected assistant's approved scope.",
    },
  },
  async (c) => {
    const { revision, ...input } = await c.req.json();
    return c.json({ data: await agents.save(ctx(c), input, { id: c.req.param("id")!, revision }) });
  },
);
r.post(
  "/:id/archive",
  {
    tag: "settings:write",
    body: Type.Object({ revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
    mcp: {
      description:
        "Archive a specialist, pause its automations and stop active tasks. Preserve its conversations for inspection.",
    },
  },
  async (c) =>
    c.json({
      data: await agents.archive(ctx(c), c.req.param("id")!, (await c.req.json()).revision),
    }),
);
r.post(
  "/:id/tasks",
  {
    tag: "settings:write",
    body: AssistantAgentTaskInput,
    mcp: {
      description:
        "Give this specialist a scoped task. Reuse requestId for the identical retry. Creates one task conversation and starts it through the ordinary assistant pipeline. Returns actual status and a link to inspect the conversation; acceptance is not task completion. It cannot exceed the initiating caller's access.",
    },
  },
  async (c) => c.json({ data: await agents.task(ctx(c), c.req.param("id")!, await c.req.json()) }),
);
r.get(
  "/:id/tasks/:chatId",
  {
    tag: "settings:read",
    mcp: {
      description:
        "Inspect one specialist task's conversation, tool activity and current state. Use this for the result; do not repeatedly poll a running task.",
    },
  },
  async (c) =>
    c.json({ data: await agents.inspect(ctx(c), c.req.param("id")!, c.req.param("chatId")!) }),
);
r.post(
  "/:id/tasks/:chatId/messages",
  {
    tag: "settings:write",
    body: AssistantAgentTaskInput,
    mcp: {
      description:
        "Continue this specialist's task in its existing chat. While running, delivers a follow-up to the same turn; after completion starts the next turn within the same resource scope. Reuse requestId for retries.",
    },
  },
  async (c) =>
    c.json({
      data: await agents.message(
        ctx(c),
        c.req.param("id")!,
        c.req.param("chatId")!,
        await c.req.json(),
      ),
    }),
);
r.post(
  "/:id/tasks/:chatId/stop",
  {
    tag: "settings:write",
    mcp: {
      description:
        "Stop this specialist task through the normal conversation cancellation flow. Keeps its transcript.",
    },
  },
  async (c) =>
    c.json({ data: await agents.stop(ctx(c), c.req.param("id")!, c.req.param("chatId")!) }),
);
export const assistantAgentRoutes = r.hono;
