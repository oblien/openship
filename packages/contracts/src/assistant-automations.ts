import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { RepositoryPatch } from "./repository-changes";

export const AUTOMATION_ACTIONS = [
  {
    id: "restart",
    label: "Restart services",
    description: "Restart the affected app’s active deployment.",
    group: "App recovery",
  },
  {
    id: "redeploy",
    label: "Redeploy the app",
    description: "Rebuild the current commit through the normal deployment pipeline.",
    group: "App recovery",
  },
  {
    id: "commit",
    label: "Commit a code fix",
    description: "Publish reviewed file changes on a new branch in the app’s repository.",
    group: "Repository",
  },
  {
    id: "pull_request",
    label: "Open a pull request",
    description: "Commit a code fix on a new branch and open a draft PR for your review.",
    group: "Repository",
  },
] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number]["id"];
const Action = Type.Union(AUTOMATION_ACTIONS.map((a) => Type.Literal(a.id)));
export const AutomationProposal = Type.Union([
  Type.Object(
    {
      action: Type.Union([Type.Literal("none"), Type.Literal("restart"), Type.Literal("redeploy")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Union([Type.Literal("commit"), Type.Literal("pull_request")]),
      patch: RepositoryPatch,
    },
    { additionalProperties: false },
  ),
]);
export type AutomationProposal = Static<typeof AutomationProposal>;

/** Old local drafts with one action stay readable; new editors write the explicit allow-list. */
export function automationActions(config: {
  action: string;
  allowedActions?: string[] | null;
}): AutomationAction[] {
  const values = config.allowedActions ?? (config.action === "none" ? [] : [config.action]);
  return AUTOMATION_ACTIONS.map((a) => a.id).filter((id) => values.includes(id));
}

export const ASSISTANT_AUTOMATION_TRIGGERS = [
  {
    id: "deployment.failed",
    label: "Deployment failed",
    description: "Investigate a failed build or deployment.",
  },
  {
    id: "service.unhealthy",
    label: "Service unhealthy",
    description: "Investigate a confirmed outage, crash loop, or failed health check.",
  },
] as const;
export const AssistantAutomationInput = Type.Object(
  {
    agentId: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    ),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    projectId: Type.String({ minLength: 1, maxLength: 128 }),
    trigger: Type.Union([Type.Literal("deployment.failed"), Type.Literal("service.unhealthy")]),
    provider: Type.Union([Type.Literal("claude"), Type.Literal("codex")]),
    model: Type.String({ maxLength: 256 }),
    mode: Type.Union([Type.Literal("report"), Type.Literal("approve"), Type.Literal("automatic")]),
    action: Type.Union([Type.Literal("none"), Type.Literal("restart"), Type.Literal("redeploy")]),
    allowedActions: Type.Optional(Type.Array(Action, { maxItems: 4, uniqueItems: true })),
    readRepository: Type.Optional(Type.Boolean()),
    instructions: Type.String({ maxLength: 2000 }),
    channelIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 20,
      uniqueItems: true,
    }),
    cooldownMinutes: Type.Integer({ minimum: 10, maximum: 1440 }),
    dailyLimit: Type.Integer({ minimum: 1, maximum: 20 }),
    enabled: Type.Boolean(),
    automaticConsent: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AssistantAutomationConfig = Static<typeof AssistantAutomationInput>;
export const AssistantAutomationSettingsInput = Type.Object(
  { paused: Type.Boolean() },
  { additionalProperties: false },
);
export const AssistantAutomationDecisionInput = Type.Object(
  { decision: Type.Union([Type.Literal("approve"), Type.Literal("cancel")]) },
  { additionalProperties: false },
);
export type AssistantAutomationState =
  | "queued"
  | "investigating"
  | "approval"
  | "applying"
  | "verifying"
  | "reported"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";
export const AssistantAutomationSchema = Type.Object(
  {
    ...Type.Omit(AssistantAutomationInput, ["automaticConsent"]).properties,
    id: Type.String({ minLength: 1, maxLength: 128 }),
    revision: Type.Integer({ minimum: 1 }),
    projectName: Type.String(),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);
export type AssistantAutomation = Static<typeof AssistantAutomationSchema>;

/** Preparing a review grants nothing. Activation accepts saved revisions, never model configuration. */
export const AssistantAutomationReviewInput = Type.Object(
  {
    automationIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export const AssistantAutomationActivationReviewSchema = Type.Object(
  {
    kind: Type.Literal("automation_activation_review"),
    organizationId: Type.String({ minLength: 1 }),
    automations: Type.Array(AssistantAutomationSchema, { minItems: 1, maxItems: 20 }),
    paused: Type.Boolean(),
    reviewPath: Type.Literal("/assistant/automations"),
  },
  { additionalProperties: false },
);
export type AssistantAutomationActivationReview = Static<
  typeof AssistantAutomationActivationReviewSchema
>;
export const AssistantAutomationActivateInput = Type.Object(
  {
    automations: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 128 }),
          revision: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 20, uniqueItems: true },
    ),
    automaticConsent: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AssistantAutomationActivation = Static<typeof AssistantAutomationActivateInput>;
export interface AssistantAutomationRun {
  id: string;
  automationId: string;
  name: string;
  projectId: string;
  projectName: string;
  state: AssistantAutomationState;
  mode: AssistantAutomationConfig["mode"];
  action: AutomationAction | "none";
  resultUrl?: string | null;
  conversationId: string | null;
  message: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}
export interface AssistantAutomationOverview {
  paused: boolean;
  automations: AssistantAutomation[];
  runs: AssistantAutomationRun[];
}
export interface AssistantAutomationPermissions {
  repository: string | null;
  read: { allowed: boolean; reason: string | null };
  source: { allowed: boolean; reason: string | null };
  actions: { id: AutomationAction; allowed: boolean; reason: string | null }[];
}

/** A recommendation is structured evidence, never authorization to execute. */
export function parseAssistantAutomationReport(text: string): {
  text: string;
  action: AutomationAction | "none" | null;
  proposal?: AutomationProposal;
} {
  const trimmed = text.trim();
  const index = trimmed.lastIndexOf("```json");
  const match = index >= 0 ? /^```json\s*(\{[\s\S]*\})\s*```\s*$/.exec(trimmed.slice(index)) : null;
  if (match) {
    try {
      const value = JSON.parse(match[1]!);
      if (Value.Check(AutomationProposal, value)) {
        return { text: trimmed.slice(0, index).trimEnd(), action: value.action, proposal: value };
      }
    } catch {
      /* Invalid or partial output remains visible and cannot propose an action. */
    }
  }
  return { text, action: null };
}
