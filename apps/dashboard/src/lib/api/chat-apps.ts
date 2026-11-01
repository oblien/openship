import { api } from "./client";
import type {
  ChatAppsStatus,
  ChatAppCreate,
  ChatAppView,
  AssistantAuthorization,
  ChatAssistantInput,
  ChatAppUpdate,
  ChatAppConfiguration,
} from "@repo/contracts";
export const chatAppsApi = {
  status: async () => (await api.get<{ data: ChatAppsStatus }>("chat-apps")).data,
  create: async (input: ChatAppCreate) =>
    (await api.post<{ data: ChatAppView }>("chat-apps", input, { timeout: 120000 })).data,
  configuration: async (id: string) =>
    (
      await api.get<{ data: ChatAppConfiguration }>(
        `chat-apps/${encodeURIComponent(id)}/configuration`,
      )
    ).data,
  configure: async (id: string, input: ChatAppUpdate) =>
    (
      await api.put<{ data: ChatAppView }>(
        `chat-apps/${encodeURIComponent(id)}/configuration`,
        input,
        { timeout: 120000 },
      )
    ).data,
  enable: async (c: ChatAppView, enabled: boolean) =>
    (
      await api.patch<{ data: ChatAppView }>(
        `chat-apps/${encodeURIComponent(c.id)}`,
        { enabled, revision: c.revision },
        { timeout: 120000 },
      )
    ).data,
  remove: (id: string) => api.delete(`chat-apps/${encodeURIComponent(id)}`),
  syncCommands: async (c: ChatAppView) =>
    (
      await api.post<{ data: ChatAppView }>(
        `chat-apps/${encodeURIComponent(c.id)}/commands/sync`,
        { revision: c.revision },
        { timeout: 120000 },
      )
    ).data,
  assistant: async (id: string, input: ChatAssistantInput) =>
    (
      await api.put<{ data: ChatAppView }>(`chat-apps/${encodeURIComponent(id)}/assistant`, input, {
        timeout: 60000,
      })
    ).data,
  unlink: (id: string) => api.post(`chat-apps/${encodeURIComponent(id)}/unlink`, {}),
  pair: async (challenge: string) =>
    (
      await api.post<{ data: AssistantAuthorization & { connectionName: string } }>(
        "chat-apps/pairing",
        { challenge },
      )
    ).data,
  complete: async (state: string, code: string) =>
    (
      await api.post<{ data: { verification: string; connectionName: string } }>(
        "chat-apps/pairing/complete",
        { state, code },
      )
    ).data,
};
