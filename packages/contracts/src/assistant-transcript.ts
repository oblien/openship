import type { AssistantEvent, AssistantMessage, AssistantPart } from "./assistant";

/** Shared by the native snapshot and browser streaming view. Mindwire owns the transcript format. */
export function appendAssistantEvents(
  messages: readonly AssistantMessage[],
  events: readonly AssistantEvent[],
  runId: string,
): AssistantMessage[] {
  const next = [...messages];
  for (const item of events) {
    if (item.user) {
      if (!next.some((m) => m.id === item.user!.id)) next.push(item.user);
      continue;
    }
    const event = item.native;
    if (event?.type === "input" && event.input) {
      const input = event.input;
      const id = `input-${input.id}`;
      const previous = next.findIndex((message) => message.id === id);
      const message: AssistantMessage = {
        id,
        chatId: "",
        role: "user",
        text: input.text,
        createdAt: input.createdAt,
        parts: [{ id: input.id, type: "user", input }],
      };
      if (previous < 0) next.push(message);
      else next[previous] = message;
      continue;
    }
    if (
      !event ||
      ![
        "text",
        "thinking",
        "tool_use",
        "tool_result",
        "interaction",
        "compaction",
        "result",
      ].includes(event.type)
    )
      continue;
    // An accepted mid-turn answer divides the same native run into visible chat messages.
    // Late tool results still update their original call above that answer.
    const partId = event.itemId ?? event.tool?.id ?? event.interaction?.id;
    let index = partId
      ? next.findIndex(
          (message) =>
            (message.id === `live-${runId}` || message.id.startsWith(`live-${runId}-input-`)) &&
            message.parts?.some((part) => part.id === partId),
        )
      : -1;
    const boundary = next.filter((message) => message.role === "user").at(-1);
    const id = boundary?.id.startsWith("input-") ? `live-${runId}-${boundary.id}` : `live-${runId}`;
    if (index < 0) index = next.findIndex((message) => message.id === id);
    if (index < 0) {
      index = next.length;
      next.push({
        id,
        chatId: "",
        role: "assistant",
        text: "",
        createdAt: event.at ?? "",
        parts: [],
      });
    }
    const message = { ...next[index]!, parts: [...(next[index]!.parts ?? [])] };
    const parts = message.parts;
    if (event.type === "text" || event.type === "thinking") {
      // Some harnesses omit item IDs. Only merge adjacent chunks; text after a
      // tool or question is a new block and must keep its place in the transcript.
      const last = parts.at(-1);
      const id =
        event.itemId ??
        (last?.type === event.type ? last.id : undefined) ??
        `text-${event.type}-${item.sequence}`;
      const previous = parts.findIndex((p) => p.id === id && p.type === event.type);
      const part: AssistantPart = {
        type: event.type,
        id,
        text: (event.delta ? (parts[previous]?.text ?? "") : "") + (event.text ?? ""),
      };
      if (previous >= 0) parts[previous] = part;
      else parts.push(part);
    } else if (event.tool) {
      const id = event.tool.id ?? `tool-${parts.length}`;
      const previous = parts.findIndex((p) => p.type === "tool" && p.id === id);
      const part: AssistantPart = {
        type: "tool",
        id,
        tool: { ...parts[previous]?.tool, ...event.tool },
      };
      if (previous >= 0) parts[previous] = part;
      else parts.push(part);
    } else if (event.interaction) {
      const id = event.interaction.id;
      const previous = parts.findIndex((p) => p.type === "interaction" && p.id === id);
      const part: AssistantPart = { type: "interaction", id, interaction: event.interaction };
      if (previous >= 0) parts[previous] = part;
      else parts.push(part);
    } else if (event.compaction) parts.push({ type: "compaction", compaction: event.compaction });
    else if (event.result?.text && !parts.some((p) => p.type === "text" && p.text))
      parts.push({ type: "text", text: event.result.text });
    message.text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
    next[index] = message;
  }
  return next;
}
