"use client";

import { useId, useState } from "react";
import type {
  AssistantAgent,
  AssistantAutomationOverview,
  AssistantConversation,
} from "@repo/contracts";
import { isAssistantActive } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { AssistantListSkeleton } from "./AssistantSkeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentAvatar";
import { agentChats } from "./rail-navigation";

export function AssistantRail({
  agents,
  chats,
  overview,
  selectedAgentId,
  selectedAutomationId,
  loading,
  error,
  busy,
  onAgent,
  onAutomation,
  onConfigure,
  onManageAutomations,
  onRetry,
}: {
  agents: AssistantAgent[];
  chats: AssistantConversation[];
  overview: AssistantAutomationOverview | null;
  selectedAgentId?: string | null;
  selectedAutomationId: string | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onAgent(id: string | null): void;
  onAutomation(id: string): void;
  onConfigure(href: string): void;
  onManageAutomations(): void;
  onRetry(): void;
}) {
  const [query, setQuery] = useState("");
  const [flowsOpen, setFlowsOpen] = useState(true);
  const flowsId = useId();
  const needle = query.trim().toLocaleLowerCase();
  const visibleAgents = agents.filter(
    (agent) =>
      !agent.archived && `${agent.name} ${agent.purpose}`.toLocaleLowerCase().includes(needle),
  );
  const visibleFlows = (overview?.automations ?? []).filter((flow) =>
    `${flow.name} ${flow.projectName}`.toLocaleLowerCase().includes(needle),
  );
  const general = agentChats(chats).filter((chat) => !chat.automationRunId);
  const active = (chat: AssistantConversation | undefined) =>
    !!chat && isAssistantActive(chat.state);
  const rowClass = (selected: boolean) =>
    cn(
      "group flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-start transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info disabled:opacity-50",
      selected && "bg-muted/70",
    );
  return (
    <nav aria-label="AI Agents workspace" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-5 pt-1">
        <Icon name="bot" className="size-4 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 text-sm font-medium">AI Agents</h2>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label="Create agent"
          title="Create agent"
          disabled={busy}
          onClick={() => onConfigure("/assistant/agents/new")}
        >
          <Icon name="plus" className="size-4" />
        </Button>
      </div>
      <div className="relative mx-2 mb-4 shrink-0">
        <Icon
          name="search"
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          variant="filled"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search agents and flows…"
          aria-label="Search agents and automations"
          className="h-10 bg-card ps-9 pe-8 text-[13px]"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Clear search"
            className="absolute end-1 top-1 size-8"
            onClick={() => setQuery("")}
          >
            <Icon name="close" className="size-3" />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pb-4">
        {(!needle || "openship assistant general".includes(needle)) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAgent(null)}
            aria-current={!selectedAgentId && !selectedAutomationId ? "page" : undefined}
            className={rowClass(!selectedAgentId && !selectedAutomationId)}
          >
            <AgentAvatar className="size-9 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">OpenShip assistant</span>
              <span className="mt-1 block truncate text-xs text-muted-foreground">
                {active(general[0])
                  ? "Working…"
                  : (general[0]?.title ?? "Your infrastructure, in conversation")}
              </span>
            </span>
            {active(general[0]) && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-info motion-safe:animate-pulse"
                aria-label="Working"
              />
            )}
          </button>
        )}
        <section aria-label="Specialist agents">
          <div className="mb-1 flex items-center gap-2 px-3">
            <h3 className="flex-1 text-xs font-medium text-muted-foreground">Agents</h3>
            <button
              type="button"
              title="Manage agents"
              aria-label="Manage agents"
              className="rounded-lg p-1 text-muted-foreground hover:text-foreground"
              onClick={() => onConfigure("/assistant/agents")}
            >
              <Icon name="settings" className="size-3.5" />
            </button>
          </div>
          {loading && !agents.length && <AssistantListSkeleton count={2} />}
          {!loading && !error && !visibleAgents.length && (
            <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">
              {needle
                ? "No matching agents."
                : "Create a specialist for logs, security or operations."}
            </p>
          )}
          {visibleAgents.map((agent) => {
            const recent = agentChats(chats, agent.id)[0] ?? agent.tasks[0];
            const working = chats.some(
              (chat) => chat.agentId === agent.id && isAssistantActive(chat.state),
            );
            return (
              <button
                key={agent.id}
                title={agent.name}
                type="button"
                disabled={busy}
                onClick={() => onAgent(agent.id)}
                aria-current={
                  selectedAgentId === agent.id && !selectedAutomationId ? "page" : undefined
                }
                className={rowClass(selectedAgentId === agent.id && !selectedAutomationId)}
              >
                <AgentAvatar icon={agent.icon} agentId={agent.id} className="size-9 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{agent.name}</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {working ? "Working…" : (recent?.title ?? agent.purpose)}
                  </span>
                </span>
                {working && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-info motion-safe:animate-pulse"
                    aria-label="Working"
                  />
                )}
              </button>
            );
          })}
        </section>
        <section aria-label="Automation switcher">
          <div className="flex items-center gap-1 px-2">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={flowsOpen || !!needle}
              aria-controls={flowsId}
              onClick={() => setFlowsOpen((value) => !value)}
            >
              <Icon
                name="chevron-down"
                className={cn(
                  "size-3.5 transition-transform",
                  !(flowsOpen || needle) && "-rotate-90",
                )}
              />
              Automations
              <span className="ms-auto text-[11px]">{overview?.automations.length ?? ""}</span>
            </button>
            <button
              type="button"
              title="Manage automations"
              aria-label="Manage automations"
              className="rounded-lg p-1 text-muted-foreground hover:text-foreground"
              onClick={onManageAutomations}
            >
              <Icon name="arrow-up-right" className="size-3.5" />
            </button>
          </div>
          <div id={flowsId} hidden={!(flowsOpen || needle)}>
            {loading && !overview && (
              <AssistantListSkeleton label="Loading automations" count={2} />
            )}
            {visibleFlows.map((flow) => {
              const running = overview?.runs.some(
                (run) =>
                  run.automationId === flow.id &&
                  ["queued", "investigating", "applying", "verifying"].includes(run.state),
              );
              const paused = !flow.enabled || overview?.paused;
              return (
                <button
                  key={flow.id}
                  title={flow.name}
                  type="button"
                  disabled={busy}
                  onClick={() => onAutomation(flow.id)}
                  aria-current={selectedAutomationId === flow.id ? "page" : undefined}
                  className={rowClass(selectedAutomationId === flow.id)}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-card text-muted-foreground">
                    <Icon name="workflow" className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{flow.name}</span>
                    <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Icon
                        name={running ? "spinner" : paused ? "pause" : "activity"}
                        className={cn("size-3", running && "motion-safe:animate-spin")}
                      />
                      {running ? "Running" : paused ? "Paused" : "Enabled"}
                      <span aria-hidden>·</span>
                      <span className="truncate">{flow.projectName}</span>
                    </span>
                  </span>
                </button>
              );
            })}
            {!visibleFlows.length && !loading && (
              <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">
                {needle
                  ? "No matching automations."
                  : "Give an agent recurring work from Automations."}
              </p>
            )}
          </div>
        </section>
        {error && (
          <div role="alert" className="px-3 text-xs">
            <p className="text-danger">{error}</p>
            <button type="button" onClick={onRetry} className="mt-2 underline underline-offset-4">
              Try again
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
