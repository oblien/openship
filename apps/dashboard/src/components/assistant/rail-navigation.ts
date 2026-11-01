import type { AssistantConversation } from "@repo/contracts";
import { assistantResumeKey } from "./use-assistant-resume";

export function agentChatKey(
  scope: string,
  clientId: string,
  targetId: string,
  agentId?: string | null,
) {
  return `${assistantResumeKey(scope, clientId, targetId)}:agent:${JSON.stringify(agentId ?? null)}`;
}

/** An ID from storage is usable only while present in this connection's scoped list. */
export function agentChats(chats: AssistantConversation[], agentId?: string | null) {
  return chats
    .filter((chat) => (chat.agentId ?? null) === (agentId ?? null))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function agentResumeChat(
  chats: AssistantConversation[],
  agentId?: string | null,
  remembered?: string | null,
) {
  const candidates = agentChats(chats, agentId).filter((chat) => agentId || !chat.automationRunId);
  return candidates.find((chat) => chat.id === remembered) ?? candidates[0] ?? null;
}
