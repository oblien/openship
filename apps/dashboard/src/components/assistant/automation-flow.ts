import {
  ASSISTANT_PROVIDER_LABELS,
  automationActions,
  type AssistantAutomationConfig,
} from "@repo/contracts";
import type { IconName } from "@repo/ui/icons";
import { outputRecord } from "./tool-output";

export const AUTOMATION_STEPS = [
  {
    title: "Trigger",
    icon: "activity",
    hint: "Choose the app and event that start this flow.",
    tone: "bg-warning-bg text-warning",
  },
  {
    title: "Investigate",
    icon: "assistant",
    hint: "Choose who investigates and what they should check.",
    tone: "bg-info-bg text-info",
  },
  {
    title: "Respond",
    icon: "shield-check",
    hint: "Decide how your agent handles the findings.",
    tone: "bg-info-bg text-info",
  },
  {
    title: "Notify",
    icon: "bell",
    hint: "Keep every run in agent chat. Add other channels for updates.",
    tone: "bg-info-bg text-info",
  },
] satisfies { title: string; icon: IconName; hint: string; tone: string }[];

export type AutomationFlowSummary = Pick<
  AssistantAutomationConfig,
  "trigger" | "provider" | "mode" | "action" | "allowedActions" | "channelIds"
> & { agentName?: string; agentId?: string | null };

/** Read only observed configuration; tool arguments are not proof of a saved flow. */
export function readAutomationFlow(value: unknown): AutomationFlowSummary | undefined {
  const row = outputRecord(value);
  if (
    !row ||
    typeof row.trigger !== "string" ||
    !["deployment.failed", "service.unhealthy"].includes(row.trigger) ||
    typeof row.provider !== "string" ||
    !["codex", "claude"].includes(row.provider) ||
    typeof row.mode !== "string" ||
    !["report", "approve", "automatic"].includes(row.mode) ||
    typeof row.action !== "string" ||
    !["none", "restart", "redeploy"].includes(row.action) ||
    !Array.isArray(row.channelIds) ||
    row.channelIds.length > 20 ||
    !row.channelIds.every((id) => typeof id === "string")
  )
    return undefined;
  return {
    trigger: row.trigger as AutomationFlowSummary["trigger"],
    provider: row.provider as AutomationFlowSummary["provider"],
    mode: row.mode as AutomationFlowSummary["mode"],
    action: row.action as AutomationFlowSummary["action"],
    allowedActions: Array.isArray(row.allowedActions)
      ? automationActions({
          action: "none",
          allowedActions: row.allowedActions.filter((id): id is string => typeof id === "string"),
        })
      : undefined,
    channelIds: row.channelIds as string[],
    agentName: typeof row.agentName === "string" ? row.agentName : undefined,
    agentId: typeof row.agentId === "string" ? row.agentId : undefined,
  };
}

export function automationFlowSteps(flow: AutomationFlowSummary) {
  const actions = automationActions(flow);
  const summaries = [
    flow.trigger === "deployment.failed" ? "Deployment fails" : "Service unhealthy",
    flow.agentName || (flow.agentId ? "Assigned agent" : ASSISTANT_PROVIDER_LABELS[flow.provider]),
    flow.mode === "report"
      ? "Investigate & report"
      : flow.mode === "approve"
        ? "Review before fixing"
        : "Apply approved fixes",
    flow.channelIds.length
      ? `Chat + ${flow.channelIds.length} ${flow.channelIds.length === 1 ? "channel" : "channels"}`
      : "Agent chat",
  ];
  return AUTOMATION_STEPS.map((step, index) => ({
    ...step,
    id: step.title.toLowerCase(),
    summary: summaries[index]!,
    icon: index === 0 && flow.trigger === "deployment.failed" ? ("rocket" as const) : step.icon,
    tone:
      index === 0 && flow.trigger === "service.unhealthy" ? "bg-danger-bg text-danger" : step.tone,
    detail:
      index === 2 && flow.mode !== "report"
        ? `${actions.length} allowed ${actions.length === 1 ? "action" : "actions"}`
        : undefined,
  }));
}
