import { Type, type Static } from "@sinclair/typebox";
import { TokenGrantSchema } from "./token-inputs";
import type { AssistantConversation } from "./assistant";

/** Specialists work on named resources. Workspace administration stays with the general assistant. */
export const ASSISTANT_AGENT_RESOURCE_TYPES = ["project", "server", "github_repository"] as const;
/** Stable avatar IDs, resolved to bundled bot artwork. No user-supplied URLs or markup. */
export const ASSISTANT_AGENT_ICONS = [
  // The default is resolved from the agent's stable ID, so unnamed choices vary too.
  { id: "bot", label: "Automatic" },
  { id: "mint", label: "Pebble" },
  { id: "terminal", label: "Sunny" },
  { id: "shield-check", label: "Gem" },
  { id: "rocket", label: "Scout" },
  { id: "activity", label: "Tilt" },
  { id: "code", label: "Orbit" },
  { id: "database", label: "Drift" },
  { id: "cloud", label: "Float" },
  { id: "bug", label: "Ember" },
  { id: "search", label: "Mochi" },
  { id: "git-branch", label: "Bean" },
  { id: "server", label: "Moss" },
  { id: "comet", label: "Comet" },
  { id: "petal", label: "Wisp" },
  { id: "puff", label: "Byte" },
  { id: "crew", label: "Crew" },
] as const;
export type AssistantAgentIcon = (typeof ASSISTANT_AGENT_ICONS)[number]["id"];
export type AssistantAgentArtwork = Exclude<AssistantAgentIcon, "bot">;
export const AssistantAgentInput = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    icon: Type.Optional(Type.Union(ASSISTANT_AGENT_ICONS.map(({ id }) => Type.Literal(id)))),
    purpose: Type.String({ minLength: 1, maxLength: 500 }),
    instructions: Type.String({ maxLength: 8000 }),
    provider: Type.Union([Type.Literal("claude"), Type.Literal("codex")]),
    model: Type.String({ maxLength: 256 }),
    readOnly: Type.Boolean(),
    grants: Type.Array(TokenGrantSchema, { minItems: 1, maxItems: 50 }),
  },
  { additionalProperties: false },
);
export type AssistantAgentConfig = Static<typeof AssistantAgentInput>;
export const AssistantAgentCreate = Type.Composite(
  [
    AssistantAgentInput,
    Type.Object({
      requestId: Type.String({ minLength: 8, maxLength: 128 }),
    }),
  ],
  { additionalProperties: false },
);
export const AssistantAgentEdit = Type.Composite(
  [
    AssistantAgentInput,
    Type.Object({
      revision: Type.Integer({ minimum: 1 }),
    }),
  ],
  { additionalProperties: false },
);
export const AssistantAgentTaskInput = Type.Object(
  {
    requestId: Type.String({ minLength: 8, maxLength: 128 }),
    message: Type.String({ minLength: 1, maxLength: 32000 }),
  },
  { additionalProperties: false },
);
export interface AssistantAgent extends AssistantAgentConfig {
  id: string;
  revision: number;
  archived: boolean;
  createdAt: string;
  tasks: AssistantConversation[];
}
export const ASSISTANT_AGENT_TEMPLATES = [
  {
    id: "logs",
    icon: "terminal",
    name: "Logs investigator",
    purpose: "Trace failures and explain what happened.",
    instructions:
      "Inspect deployment logs, service health and recent changes for the assigned apps. Trace the cause using evidence, distinguish facts from hypotheses, and report a practical next step. Never repeat credentials or secret environment values.",
  },
  {
    id: "security",
    icon: "shield-check",
    name: "Security reviewer",
    purpose: "Review security findings for your apps.",
    instructions:
      "Review available security advisories and runtime or image evidence for the assigned apps. Explain affected versions, uncertainty and supported remediation. Never claim a complete vulnerability scan without evidence. Use normal deployment operations for any authorized patch.",
  },
  {
    id: "devops",
    icon: "rocket",
    name: "Deployment assistant",
    purpose: "Handle scoped deployment and recovery tasks.",
    instructions:
      "Inspect the assigned apps and their recent deployments. Carry out the user's authorized deployment or recovery task through normal OpenShip tools, then verify the resulting status. Report the actual outcome and any remaining issue.",
  },
] as const;
