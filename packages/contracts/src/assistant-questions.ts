import type { AssistantMessage, AssistantNativeEvent } from "./assistant";

export type AssistantQuestion = NonNullable<AssistantNativeEvent["interaction"]> & { id: string };
export interface AssistantQuestionRequest {
  key: string;
  interaction: AssistantQuestion;
}

/** Native requests belong to a live run; message-mode questions also remain answerable in history. */
export function pendingAssistantQuestions(
  messages: readonly AssistantMessage[],
  runId: string | null,
  active: boolean,
): AssistantQuestionRequest[] {
  const requests = new Map<string, AssistantQuestionRequest>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const live = Boolean(
      active &&
      runId &&
      (message.id === `live-${runId}` || message.id.startsWith(`live-${runId}-input-`)),
    );
    for (const part of message.parts ?? []) {
      const interaction = part.interaction;
      if (!interaction?.id) continue;
      if (
        interaction.responseMode !== "message" &&
        !live &&
        !(active && interaction.runId === runId)
      )
        continue;
      const key = JSON.stringify([
        interaction.runId ?? (interaction.responseMode === "message" ? "" : runId),
        interaction.id,
      ]);
      // A later response replaces an older pending copy, including across message boundaries.
      requests.set(key, { key, interaction: interaction as AssistantQuestion });
    }
  }
  return [...requests.values()].filter(
    ({ interaction }) =>
      interaction.needsResponse && !interaction.response && Boolean(interaction.questions?.length),
  );
}
