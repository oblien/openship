import type {
  AssistantAutomationRun,
  AssistantAutomationConfig,
  AssistantAutomationOverview,
  AssistantAutomationPermissions,
  AutomationProposal,
  AssistantAutomationActivation,
  AssistantAutomationActivationReview,
} from "@repo/contracts";
import { api } from "./client";
const root = "/assistant";
export const assistantAutomationsApi = {
  reviewActivation: async (automationIds: string[]) =>
    (
      await api.post<{ data: AssistantAutomationActivationReview }>(
        `${root}/automation-activation-review`,
        { automationIds },
      )
    ).data,
  activate: async (input: AssistantAutomationActivation) =>
    (
      await api.post<{ data: AssistantAutomationActivationReview }>(
        `${root}/automation-activation`,
        input,
      )
    ).data,
  run: async (runId: string) =>
    (
      await api.get<{ data: AssistantAutomationRun }>(
        `${root}/automation-runs/${encodeURIComponent(runId)}`,
      )
    ).data,
  permissions: async (projectId: string, agentId?: string) =>
    (
      await api.get<{ data: AssistantAutomationPermissions }>(
        `${root}/automation-permissions/${encodeURIComponent(projectId)}`,
        { params: agentId ? { agentId } : {} },
      )
    ).data,
  proposal: async (runId: string) =>
    (
      await api.get<{ data: AutomationProposal }>(
        `${root}/automation-runs/${encodeURIComponent(runId)}/proposal`,
      )
    ).data,
  overview: async () =>
    (await api.get<{ data: AssistantAutomationOverview }>(`${root}/automations`)).data,
  save: async (input: AssistantAutomationConfig, id?: string) =>
    id
      ? api.put(`${root}/automations/${encodeURIComponent(id)}`, input)
      : api.post(`${root}/automations`, input),
  pause: (paused: boolean) => api.patch(`${root}/automation-settings`, { paused }),
  disable: (id: string) => api.delete(`${root}/automations/${encodeURIComponent(id)}`),
  decide: (id: string, decision: "approve" | "cancel") =>
    api.post(`${root}/automation-runs/${encodeURIComponent(id)}/decision`, { decision }),
};
