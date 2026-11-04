import type {
  AssistantAgent,
  AssistantAgentConfig,
  AssistantConversation,
  AssistantActivity,
} from "@repo/contracts";
import { api } from "./client";
const root = "/assistant/agents";
export const assistantAgentsApi = {
  list: async () => (await api.get<{ data: AssistantAgent[] }>(root, { timeout: 60000 })).data,
  get: async (id: string) =>
    (
      await api.get<{ data: AssistantAgent }>(`${root}/${encodeURIComponent(id)}`, {
        timeout: 60000,
      })
    ).data,
  save: async (
    input: AssistantAgentConfig,
    intent: { requestId: string } | { id: string; revision: number },
  ) =>
    ("id" in intent
      ? await api.put<{ data: AssistantAgent }>(
          `${root}/${encodeURIComponent(intent.id)}`,
          { ...input, revision: intent.revision },
          { timeout: 60000 },
        )
      : await api.post<{ data: AssistantAgent }>(
          root,
          { ...input, requestId: intent.requestId },
          { timeout: 60000 },
        )
    ).data,
  archive: async (id: string, revision: number) =>
    api.post(`${root}/${encodeURIComponent(id)}/archive`, { revision }),
  task: async (id: string, message: string, requestId: string) =>
    (
      await api.post<{
        data: { conversation: AssistantConversation; activity: AssistantActivity; path: string };
      }>(`${root}/${encodeURIComponent(id)}/tasks`, { message, requestId }, { timeout: 90000 })
    ).data,
};
