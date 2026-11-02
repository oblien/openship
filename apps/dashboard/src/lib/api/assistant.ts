import type {
  AssistantActivity,
  AssistantAuthorization,
  AssistantConversation,
  AssistantProvider,
  AssistantProviderInfo,
  AssistantSnapshot,
  AssistantStatus,
  AuthState,
  AssistantTurnInput,
  QuestionAnswer,
} from "@repo/contracts";
import { api } from "./client";
const root = "assistant";
const conversation = (id: string) => `${root}/conversations/${encodeURIComponent(id)}`;
const provider = (id: AssistantProvider) => `${root}/providers/${id}`;
export const assistantApi = {
  customApi: async (input: { name: string; baseUrl: string; apiKey: string; model: string }) =>
    (await api.post<{ data: { model: string } }>(`${root}/custom-api`, input)).data,
  status: async () => (await api.get<{ data: AssistantStatus }>(`${root}/status`)).data,
  enable: async (targetId?: string) =>
    (await api.post<{ data: AssistantAuthorization }>(`${root}/enable`, { targetId })).data,
  completeAuthorization: async (state: string, code: string) =>
    (
      await api.get<{ data: { enabled: boolean } }>(`${root}/callback`, {
        params: { state, code },
        headers: { Accept: "application/json" },
      })
    ).data,
  disable: () => api.post(`${root}/disable`, {}),
  providers: async () =>
    (await api.get<{ data: AssistantProviderInfo[] }>(`${root}/providers`, { timeout: 60000 }))
      .data,
  provider: async (id: AssistantProvider) =>
    (await api.get<{ data: AssistantProviderInfo }>(provider(id), { timeout: 60000 })).data,
  authBegin: async (id: AssistantProvider, method: string) =>
    (await api.post<{ data: AuthState }>(`${provider(id)}/auth`, { method }, { timeout: 60000 }))
      .data,
  authStep: async (id: AssistantProvider, fields: Record<string, string>) =>
    (
      await api.post<{ data: AuthState }>(
        `${provider(id)}/auth/step`,
        { fields },
        { timeout: 60000 },
      )
    ).data,
  logout: (id: AssistantProvider) => api.post(`${provider(id)}/logout`, {}),
  configure: (id: AssistantProvider, settings: Record<string, string>) =>
    api.patch(provider(id), { settings }),
  list: async () =>
    (await api.get<{ data: AssistantConversation[] }>(`${root}/conversations`)).data,
  create: async (input: { provider: AssistantProvider; model: string; agentId?: string }) =>
    (await api.post<{ data: AssistantConversation }>(`${root}/conversations`, input)).data,
  get: async (id: string, signal?: AbortSignal) =>
    (await api.get<{ data: AssistantSnapshot }>(conversation(id), { signal, timeout: 60000 })).data,
  history: async (id: string, before: string) =>
    (
      await api.get<{ data: Pick<AssistantSnapshot, "messages" | "hasMore" | "before"> }>(
        `${conversation(id)}/history`,
        { params: { before } },
      )
    ).data,
  start: async (id: string, input: AssistantTurnInput) =>
    (
      await api.post<{ data: AssistantActivity }>(`${conversation(id)}/turns`, input, {
        timeout: 90000,
      })
    ).data,
  message: async (id: string, input: { requestId: string; message: string }) =>
    (
      await api.post<{ data: AssistantActivity }>(`${conversation(id)}/messages`, input, {
        timeout: 90000,
      })
    ).data,
  activity: async (
    id: string,
    input: { runId: string | null; after: number },
    signal: AbortSignal,
  ) =>
    (
      await api.post<{ data: AssistantActivity }>(
        `${conversation(id)}/activity`,
        { ...input, runId: input.runId ?? undefined, waitMs: 25000 },
        { signal, timeout: 35000 },
      )
    ).data,
  stop: (id: string) => api.post(`${conversation(id)}/stop`, {}),
  remove: (id: string) => api.delete(conversation(id)),
  respond: (
    id: string,
    input: { interactionId: string; requestId: string; answers: Record<string, QuestionAnswer> },
  ) => api.post(`${conversation(id)}/respond`, input, { timeout: 90000 }),
};
