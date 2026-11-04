"use client";

import type { AssistantAgent, AssistantConversation } from "@repo/contracts";
import { AgentLink } from "./AgentLink";
import { SkeletonBlock } from "./AssistantSkeletons";

/** The speaker and the conversation are separate identities, including while loading. */
export function AssistantChatIdentity({
  conversation,
  agent,
  loading,
}: {
  conversation?: AssistantConversation;
  agent?: AssistantAgent | null;
  loading: boolean;
}) {
  if (loading)
    return (
      <div
        role="status"
        aria-label="Opening conversation"
        aria-busy="true"
        className="flex min-w-0 items-center gap-3"
      >
        <SkeletonBlock className="h-5 w-48 max-w-full" />
      </div>
    );
  const agentId = conversation?.agentId;
  const name = agentId ? (agent?.name ?? "Agent") : "OpenShip assistant";
  const kind = conversation?.automationRunId ? "Automation" : agentId ? "Agent" : "General";
  const title = conversation?.title ?? "New chat";

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <h1 className="min-w-0 truncate text-xl font-medium text-foreground" title={title}>
        {agentId ? (
          <AgentLink href={`/assistant/agents/${agentId}`} className="hover:text-muted-foreground">
            {name}
          </AgentLink>
        ) : (
          name
        )}
      </h1>
      <span className="shrink-0 rounded-md bg-card px-2 py-1 text-[11px] leading-none text-muted-foreground">
        {kind}
      </span>
    </div>
  );
}
