"use client";

import { ChatCore, ChatSnapshotProvider } from "@mindwire-ai/client";
import { normalizeMindwireMessages } from "@mindwire-ai/client/mindwire";
import type { AssistantPart, AssistantMessage } from "@repo/contracts";
import { assistantTools, visibleAssistantParts } from "./assistant-client-tools";

export function AssistantToolActivity({
  parts,
  active,
  streaming = false,
}: {
  parts: AssistantPart[];
  active: boolean;
  streaming?: boolean;
}) {
  const message: AssistantMessage = {
    id: "activity",
    chatId: "activity",
    role: "assistant",
    text: "",
    createdAt: "",
    parts,
  };
  const messages = normalizeMindwireMessages(
    [{ ...message, parts: visibleAssistantParts(message) }],
    { isActive: () => active || streaming },
  );
  return (
    <ChatSnapshotProvider sessionId="activity" messages={messages} tools={assistantTools}>
      <ChatCore
        virtualization="none"
        contentPaddingStart={0}
        contentPaddingEnd={0}
        showWelcome={false}
        showLoadingIndicator={false}
      />
    </ChatSnapshotProvider>
  );
}
