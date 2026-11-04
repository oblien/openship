import type { Event, Interaction, Message, Part, ToolPart, UserInput } from "mindwire";
import { assistantMessageImages } from "@repo/contracts";

/** Explain known connection failures without exposing native URLs, paths or credentials. */
export function assistantFailure(error?: string): string {
  if (/\b401\b|\bunauthorized\b|invalid (?:subscription|api) key/i.test(error ?? ""))
    return /azure|subscription key/i.test(error ?? "")
      ? "The saved Azure connection was rejected (401). Open Your agents to update its credentials or choose another connection."
      : "Your agent connection was rejected (401). Open Your agents to reconnect or choose another connection.";
  return "The agent could not finish this turn. Check its connection and try again.";
}

function userInput(value: UserInput): UserInput {
  return {
    id: value.id,
    text: value.text,
    createdAt: value.createdAt,
    status: value.status,
    ...(value.error
      ? { error: "The agent could not accept this answer. Please send it again." }
      : {}),
  };
}

function tool(value: ToolPart): ToolPart {
  const input = value.input;
  // Optional on newer daemons; preserve explicit outcomes without requiring an
  // SDK upgrade or exposing the rest of the native transport metadata.
  const status =
    "status" in value &&
    typeof value.status === "string" &&
    ["completed", "failed", "cancelled", "incomplete"].includes(value.status)
      ? value.status
      : undefined;
  const argumentsOnly =
    input &&
    typeof input === "object" &&
    "type" in input &&
    (input.type === "mcpToolCall" ||
      input.type === "McpToolCall" ||
      input.type === "mcp_tool_call") &&
    "arguments" in input
      ? input.arguments
      : input;
  return {
    id: value.id,
    name: value.name,
    input: argumentsOnly,
    output: value.output,
    isError: value.isError,
    ...(status ? { status } : {}),
    ...(value.action?.kind === "mcp"
      ? { action: { kind: "mcp", title: value.action.title, mcp: value.action.mcp } }
      : {}),
  };
}
function interaction(value: Interaction): Interaction {
  const { meta: _meta, runId: _run, ...safe } = value;
  return value.kind === "error" ? { ...safe, detail: assistantFailure(value.detail) } : safe;
}
function part(value: Part): Part {
  const { input: _input, ...safe } = value;
  return {
    ...safe,
    ...(value.input ? { input: userInput(value.input) } : {}),
    ...(safe.tool ? { tool: tool(safe.tool) } : {}),
    ...(safe.interaction ? { interaction: interaction(safe.interaction) } : {}),
  };
}
/** Keep native transport metadata and duplicate MCP payloads out of the product transcript. */
export function assistantMessages(messages: Message[], conversationId: string): Message[] {
  return messages.map(({ attachments, canFork: _fork, ...message }) => ({
    ...message,
    chatId: conversationId,
    ...(message.role === "user" && attachments?.length
      ? { attachments: assistantMessageImages(attachments) }
      : {}),
    parts: message.parts?.map(part),
  }));
}
export function assistantEvent(value: Event): Event | undefined {
  if (value.type === "session") return;
  const {
    meta: _meta,
    sessionId: _session,
    continuation: _continuation,
    input: _input,
    ...safe
  } = value;
  if (safe.result) {
    const { sessionId: _nativeSession, ...result } = safe.result;
    safe.result = {
      ...result,
      ...(result.isError
        ? // The turn's error is presented once in the transcript, alongside any partial answer.
          { text: "" }
        : {}),
    };
  }
  if (safe.error) safe.error = assistantFailure(safe.error);
  if (safe.tool) safe.tool = tool(safe.tool);
  if (safe.interaction) safe.interaction = interaction(safe.interaction);
  return value.type === "input" && value.input ? { ...safe, input: userInput(value.input) } : safe;
}
