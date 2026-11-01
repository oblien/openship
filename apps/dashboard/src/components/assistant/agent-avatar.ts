import { ASSISTANT_AGENT_ICONS, type AssistantAgentArtwork } from "@repo/contracts";

export const AGENT_AVATAR_CHOICES = ASSISTANT_AGENT_ICONS.filter(
  (item): item is Exclude<(typeof ASSISTANT_AGENT_ICONS)[number], { id: "bot" }> =>
    item.id !== "bot",
);

// Keep the general assistant's mint pebble recognizable. Specialists receive a
// stable character, even when created through MCP without an explicit choice.
const defaults = AGENT_AVATAR_CHOICES.filter((item) => item.id !== "mint" && item.id !== "crew");

export function resolveAgentAvatar(icon?: string, agentId?: string): AssistantAgentArtwork {
  const chosen = AGENT_AVATAR_CHOICES.find((item) => item.id === icon);
  if (chosen) return chosen.id;
  if (!agentId) return "mint";
  let hash = 2166136261;
  for (const character of agentId) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return defaults[(hash >>> 0) % defaults.length]!.id;
}
