import type { ChatAppConnection } from "@repo/db";
import { repos } from "@repo/db";
import { challenge, readChallenge, senderKey, fail } from "./chat-apps-common";
import { chatReply, type ChatReply } from "./chat-reply";
import type { HostEvent } from "./transport/types";

interface ButtonAction {
  sender: string;
  revision: number;
  identityId: string | null;
  clientId: string | null;
  command: string;
}

/** Buttons are expiring capabilities, bound to the sender, chat, connection and approved identity. */
export async function chatActions(
  c: ChatAppConnection,
  event: HostEvent,
  text: string,
  actions: { label: string; command: string }[],
): Promise<ChatReply> {
  if (c.provider !== "telegram" || !actions.length) return chatReply(text);
  const identity = await repos.chatApps.identity(c.id, event.workspaceId, event.userId);
  const buttons = await Promise.all(
    actions.slice(0, 20).map(async (action) => ({
      label: action.label.slice(0, 60),
      token: await challenge(
        c.id,
        "button",
        {
          sender: senderKey(event),
          revision: c.revision,
          identityId: identity?.id ?? null,
          clientId: identity?.clientId ?? null,
          command: action.command,
        } satisfies ButtonAction,
        15,
      ),
    })),
  );
  return chatReply({ text, buttons });
}

export async function resolveChatAction(c: ChatAppConnection, event: HostEvent) {
  if (!event.callback) return event;
  const action = await readChallenge<ButtonAction>(event.callback, "button");
  const identity = await repos.chatApps.identity(c.id, event.workspaceId, event.userId);
  if (
    action.connectionId !== c.id ||
    action.value.revision !== c.revision ||
    action.value.sender !== senderKey(event) ||
    action.value.identityId !== (identity?.id ?? null) ||
    action.value.clientId !== (identity?.clientId ?? null)
  )
    throw fail("Use the same account and conversation that requested this action.", 403);
  return { ...event, command: true, text: action.value.command };
}
