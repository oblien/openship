import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Value } from "@sinclair/typebox/value";
import { AssistantAgentCreate } from "@repo/contracts";
import { AgentAvatar } from "./AgentAvatar";
import { AGENT_AVATAR_CHOICES, resolveAgentAvatar } from "./agent-avatar";

describe("agent character identity", () => {
  it("varies default specialists and keeps their look when the list order changes", () => {
    const agents = ["ui-agent", "ui-security", "ui-new-agent"];
    const before = new Map(agents.map((id) => [id, resolveAgentAvatar("bot", id)]));
    expect(new Set(before.values()).size).toBe(agents.length);
    expect(resolveAgentAvatar()).toBe("mint");
    for (const id of [...agents].reverse()) {
      expect(resolveAgentAvatar(undefined, id)).toBe(before.get(id));
      const rendered = renderToStaticMarkup(<AgentAvatar agentId={id} icon="bot" />);
      expect(rendered).toContain(`data-bot-avatar="${before.get(id)}"`);
    }
  });

  it("always honors an explicit choice, including the general assistant's mint character", () => {
    for (const choice of AGENT_AVATAR_CHOICES) {
      expect(resolveAgentAvatar(choice.id, "original-agent")).toBe(choice.id);
      expect(resolveAgentAvatar(choice.id, "another-agent")).toBe(choice.id);
    }
  });

  it("uses a local character for missing or unknown choices", () => {
    for (const icon of [undefined, "bot", "old-choice", "https://example.com/avatar.svg"]) {
      expect(resolveAgentAvatar(icon, "ui-agent")).toBe(resolveAgentAvatar("bot", "ui-agent"));
    }
  });

  it("accepts every selectable character through the native agent contract", () => {
    const draft = {
      requestId: "avatar-draft-request",
      name: "Logs investigator",
      purpose: "Inspect logs",
      instructions: "",
      provider: "codex",
      model: "",
      readOnly: true,
      grants: [{ resourceType: "project", resourceId: "project-a", permissions: ["read"] }],
    };
    for (const { id } of AGENT_AVATAR_CHOICES) {
      expect(Value.Check(AssistantAgentCreate, { ...draft, icon: id })).toBe(true);
    }
    expect(Value.Check(AssistantAgentCreate, draft)).toBe(true);
    expect(Value.Check(AssistantAgentCreate, { ...draft, icon: "bot" })).toBe(true);
    expect(Value.Check(AssistantAgentCreate, { ...draft, icon: "https://example.com/a.svg" })).toBe(
      false,
    );
  });
});
