import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import {
  AssistantAutomationInput,
  AssistantAutomationSettingsInput,
  AssistantAutomationDecisionInput,
  AssistantAutomationReviewInput,
  AssistantAutomationActivateInput,
} from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import { getRequestContext as ctx } from "../../lib/request-context";
import { assistantAutomations as flows } from "./automation.service";

/** Normal authenticated domain operations: UI and MCP dispatch through these exact handlers. */
const r = secureRouter(new Hono(), { module: "assistant-automations", basePath: "/api/assistant" });
r.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
r.get(
  "/automations",
  {
    tag: "settings:read",
    mcp: {
      description:
        "List your workspace's assistant automations and recent runs. Flows react to deployment.failed or service.unhealthy and can use a saved scoped agent. Each run links to one inspectable task conversation. Includes paused state, notification channels, and approval status.",
    },
  },
  async (c) => c.json({ data: await flows.overview(ctx(c)) }),
);
r.get(
  "/automation-permissions/:projectId",
  {
    tag: "settings:read",
    query: Type.Object({ agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
    mcp: {
      description:
        "Check the current assistant's allowed investigation, deployment and repository actions for an app before configuring a flow. This grants no permissions.",
    },
  },
  async (c) =>
    c.json({
      data: await flows.permissions(ctx(c), c.req.param("projectId")!, c.req.query("agentId")),
    }),
);
r.post(
  "/automation-activation-review",
  {
    tag: "settings:read",
    readOnly: true,
    body: AssistantAutomationReviewInput,
    mcp: {
      description:
        "Offer inline activation of saved automations. When the user asks to enable or run flows, call this with their automationIds after preparing the paused configurations. Returns the exact apps, triggers, actions and limits for an Enable & continue review in chat. This read-only operation enables nothing and grants no access. Use this handoff instead of refusing or asking the user to toggle settings manually. After approval, inspect current state and continue the original task. reviewPath is a fallback for external MCP clients.",
    },
  },
  async (c) =>
    c.json({ data: await flows.activationReview(ctx(c), (await c.req.json()).automationIds) }),
);
r.post(
  "/automation-activation",
  {
    tag: "settings:write",
    body: AssistantAutomationActivateInput,
    mcpExcluded:
      "User approval of saved automation revisions. Agents offer the read-only activation review.",
  },
  async (c) => c.json({ data: await flows.activate(ctx(c), await c.req.json()) }),
);
r.get(
  "/automation-runs/:id",
  {
    tag: "settings:read",
    mcp: {
      description:
        "Inspect an automation run's actual state, result and task conversation ID. Never report action acceptance as verified recovery.",
    },
  },
  async (c) => c.json({ data: await flows.run(ctx(c), c.req.param("id")!) }),
);
r.get(
  "/automation-runs/:id/proposal",
  {
    tag: "settings:read",
    mcp: {
      description:
        "Read the exact saved remediation proposal for an automation run, including a proposed repository patch. Approval must be given by the user in OpenShip.",
    },
  },
  async (c) => c.json({ data: await flows.proposal(ctx(c), c.req.param("id")!) }),
);
r.post(
  "/automations",
  {
    tag: "settings:write",
    body: AssistantAutomationInput,
    mcp: {
      description:
        "Create an assistant automation through the normal flow API. Choose a project, confirmed incident trigger, optional scoped agentId, response mode and existing channelIds. Agent callers save enabled=false and automaticConsent=false. If activation is part of the user's request, next call post_assistant_automation_activation_review with the saved automationIds to offer Enable & continue inside chat. Preparing a flow is not enabling it. No extra scheduler or bot connection is created.",
    },
  },
  async (c) => c.json({ data: await flows.save(ctx(c), await c.req.json()) }),
);
r.put(
  "/automations/:id",
  {
    tag: "settings:write",
    body: AssistantAutomationInput,
    mcp: {
      description:
        "Update a paused automation using the same validations as its editor. Pause an enabled flow before editing it. Save enabled=false and automaticConsent=false, then use post_assistant_automation_activation_review when the user wants it enabled. Changes invalidate pending runs; the inline review approves the exact saved revision.",
    },
  },
  async (c) => c.json({ data: await flows.save(ctx(c), await c.req.json(), c.req.param("id")!) }),
);
r.delete(
  "/automations/:id",
  {
    tag: "settings:write",
    mcp: {
      description:
        "Pause this automation and cancel unclaimed work. Keeps its run history and task chats.",
    },
  },
  async (c) => c.json({ data: await flows.disable(ctx(c), c.req.param("id")!) }),
);
r.patch(
  "/automation-settings",
  {
    tag: "settings:write",
    body: AssistantAutomationSettingsInput,
    mcp: {
      description:
        "Pause all your assistant automations in this workspace with paused=true. Resuming requires the user in OpenShip.",
    },
  },
  async (c) => c.json({ data: await flows.pause(ctx(c), (await c.req.json()).paused) }),
);
r.post(
  "/automation-runs/:id/decision",
  {
    tag: "settings:write",
    body: AssistantAutomationDecisionInput,
    mcp: {
      description:
        "Cancel pending automation work with decision=cancel. decision=approve is reserved for the user's OpenShip session; an agent can never approve its own proposed fix.",
    },
  },
  async (c) =>
    c.json({ data: await flows.decide(ctx(c), c.req.param("id")!, (await c.req.json()).decision) }),
);
export const automationRoutes = r.hono;
