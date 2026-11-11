import { describe, expect, it } from "vitest";
import type { AssistantConversation } from "@repo/contracts";
import { agentChatKey, agentChats, agentResumeChat } from "./rail-navigation";

const chat = (
  id: string,
  updatedAt: string,
  agentId?: string,
  automationRunId?: string,
): AssistantConversation => ({
  id,
  updatedAt,
  agentId,
  automationRunId,
  title: id,
  provider: "codex",
  model: "",
  state: "done",
  createdAt: updatedAt,
});
const chats = [
  chat("general", "2026-10-29"),
  chat("logs-old", "2026-10-29", "logs"),
  chat("security", "2026-10-31", "security"),
  chat("logs-new", "2026-10-30", "logs"),
  chat("automatic", "2026-10-31", undefined, "run"),
];
describe("agent conversation navigation", () => {
  it("resumes the remembered conversation only if it belongs to the selected agent and current scoped list", () => {
    expect(agentResumeChat(chats, "logs", "logs-old")?.id).toBe("logs-old");
    expect(agentResumeChat(chats, "logs", "security")?.id).toBe("logs-new");
    expect(agentResumeChat(chats, "logs", "foreign-chat")?.id).toBe("logs-new");
    expect(agentResumeChat(chats, "unavailable", "logs-old")).toBeNull();
  });
  it("keeps general conversations separate from specialist and automated investigation contexts", () => {
    expect(agentResumeChat(chats, null, "security")?.id).toBe("general");
    expect(agentResumeChat(chats, null, "automatic")?.id).toBe("general");
    expect(agentResumeChat([], "logs")).toBeNull();
  });
  it("orders recent conversations without changing the source list", () => {
    expect(agentChats(chats, "logs").map((chat) => chat.id)).toEqual(["logs-new", "logs-old"]);
    expect(chats[1]?.id).toBe("logs-old");
  });
  it("binds remembered IDs to the account, workspace, connection, host and agent", () => {
    const keys = [
      agentChatKey("account:org", "client", "host", "logs"),
      agentChatKey("other:org", "client", "host", "logs"),
      agentChatKey("account:other-org", "client", "host", "logs"),
      agentChatKey("account:org", "other-client", "host", "logs"),
      agentChatKey("account:org", "client", "other-host", "logs"),
      agentChatKey("account:org", "client", "host", "security"),
      agentChatKey("account:org", "client", "host", null),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
