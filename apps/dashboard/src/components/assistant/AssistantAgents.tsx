"use client";
import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import {
  ASSISTANT_AGENT_TEMPLATES,
  ASSISTANT_PROVIDER_LABELS,
  isAssistantActive,
  type AssistantAgent,
} from "@repo/contracts";
import { Button } from "@/components/ui/button";
import { useScopedResource, useScopedMutation } from "@/hooks/use-scoped-resource";
import { assistantAgentsApi } from "@/lib/api/assistant-agents";
import { assistantApi } from "@/lib/api/assistant";
import { AssistantIllustration } from "./AssistantIllustration";
import { AssistantDialog } from "./AssistantDialog";
import { AgentLink, useAgentNavigation } from "./AgentLink";
import { AgentAvatar } from "./AgentAvatar";
import { AssistantListSkeleton, SkeletonBlock } from "./AssistantSkeletons";

export function AssistantAgents({ id }: { id?: string }) {
  const navigation = useAgentNavigation();
  const status = useScopedResource(assistantApi.status);
  const load = useCallback(
    () =>
      status.data?.enabled
        ? id
          ? assistantAgentsApi.get(id).then((a) => [a])
          : assistantAgentsApi.list()
        : Promise.resolve([]),
    [id, status.data?.enabled],
  );
  const data = useScopedResource(load, 10000);
  const waiting = (status.loading || data.loading) && !data.data?.length;
  return (
    <>
      <header className="shrink-0 px-6 pb-6 pt-7 sm:px-8">
        {id && (
          <AgentLink
            href="/assistant/agents"
            className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <Icon name="arrow-left" className="size-4" /> All agents
          </AgentLink>
        )}
        <div className="flex items-start gap-4 pe-10">
          {id &&
            (waiting ? (
              <SkeletonBlock className="size-16 shrink-0 rounded-full" />
            ) : (
              <AgentAvatar icon={data.data?.[0]?.icon} agentId={id} className="size-16" />
            ))}
          <div className="min-w-0">
            <h2 className="break-words text-2xl font-medium text-foreground">
              {id ? (
                waiting ? (
                  <SkeletonBlock className="h-7 w-44" />
                ) : (
                  (data.data?.[0]?.name ?? "Agent")
                )
              ) : (
                "Agents"
              )}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {id ? (
                waiting ? (
                  <SkeletonBlock className="h-3 w-52 max-w-full" />
                ) : (
                  data.data?.[0]?.purpose
                )
              ) : (
                "Specialists for your apps. Give one a task or put it to work in an automation."
              )}
            </p>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-8 sm:px-8">
        {(data.error || status.error) && (
          <div
            role="alert"
            className="mb-5 flex items-center gap-3 rounded-xl bg-card p-4 text-sm text-danger"
          >
            {data.error ?? status.error}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                status.refresh();
                data.refresh();
              }}
            >
              Retry
            </Button>
          </div>
        )}
        {waiting ? (
          <AssistantListSkeleton />
        ) : !status.data?.enabled && !status.error ? (
          <div className="py-16 text-center">
            <h2 className="text-xl font-medium">Connect your assistant first</h2>
            <p className="my-4 text-sm text-muted-foreground">
              Agents use your connected AI and approved OpenShip access.
            </p>
            <Button onClick={navigation?.close}>
              Set up assistant <Icon name="arrow-right" />
            </Button>
          </div>
        ) : id && data.data?.[0] ? (
          <AgentDetail agent={data.data[0]} onRefresh={data.refresh} />
        ) : !id && data.data && !data.error ? (
          <AgentList agents={data.data} />
        ) : null}
      </div>
    </>
  );
}
function AgentList({ agents }: { agents: AssistantAgent[] }) {
  const active = agents.filter((a) => !a.archived);
  return (
    <div className="space-y-9">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">
          Your agents <span className="ms-1.5 text-muted-foreground">{active.length}</span>
        </h3>
        <Button asChild size="sm">
          <AgentLink href="/assistant/agents/new">
            <Icon name="plus" /> Create agent
          </AgentLink>
        </Button>
      </div>
      <div className="space-y-3">
        {!active.length && (
          <div className="flex flex-col items-center rounded-3xl bg-card px-6 py-12 text-center">
            <div className="mb-5 w-64 max-w-full">
              <AssistantIllustration />
            </div>
            <h2 className="text-xl font-medium">A specialist for the work you repeat.</h2>
            <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
              Trace a failed deploy, review a security finding, or take care of an app. You choose
              its scope.
            </p>
          </div>
        )}
        {active.map((agent) => (
          <AgentLink
            key={agent.id}
            href={`/assistant/agents/${agent.id}`}
            className="group flex items-start gap-3 rounded-2xl bg-card p-4 transition-colors hover:bg-muted/60 sm:gap-4 sm:p-5"
          >
            <AgentAvatar icon={agent.icon} agentId={agent.id} />
            <div className="min-w-0 flex-1">
              <h3 className="break-words font-medium">{agent.name}</h3>
              <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
                {agent.purpose}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Icon name={agent.provider} className="size-3.5" />
                  {ASSISTANT_PROVIDER_LABELS[agent.provider]}
                </span>
                <span>{agent.readOnly ? "Read only" : "Approved actions"}</span>
                <span>
                  {agent.tasks.length} {agent.tasks.length === 1 ? "task" : "tasks"}
                  {agent.tasks.some((t) => isAssistantActive(t.state)) ? " · Working" : ""}
                </span>
              </div>
            </div>
            <Icon
              name="arrow-right"
              className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1 motion-reduce:transition-none"
            />
          </AgentLink>
        ))}
        {agents.some((a) => a.archived) && (
          <details className="px-2 pt-4 text-sm text-muted-foreground">
            <summary className="cursor-pointer">Archived agents</summary>
            <div className="mt-3 space-y-2">
              {agents
                .filter((a) => a.archived)
                .map((a) => (
                  <AgentLink
                    className="block hover:text-foreground"
                    key={a.id}
                    href={`/assistant/agents/${a.id}`}
                  >
                    {a.name} · {a.tasks.length} {a.tasks.length === 1 ? "task" : "tasks"}
                  </AgentLink>
                ))}
            </div>
          </details>
        )}
      </div>
      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">Start with a purpose</h3>
        </div>
        <div className="space-y-2">
          {ASSISTANT_AGENT_TEMPLATES.map((t) => (
            <AgentLink
              key={t.id}
              href={`/assistant/agents/new?template=${t.id}`}
              className="group flex items-start gap-3 rounded-xl p-3 transition-colors hover:bg-card"
            >
              <AgentAvatar icon={t.icon} className="size-10" />
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-medium">{t.name}</h4>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t.purpose}</p>
              </div>
              <Icon name="plus" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            </AgentLink>
          ))}
        </div>
      </section>
    </div>
  );
}
function AgentDetail({ agent, onRefresh }: { agent: AssistantAgent; onRefresh(): void }) {
  const router = useRouter();
  const mutation = useScopedMutation();
  const navigation = useAgentNavigation();
  const [archiving, setArchiving] = useState(false);
  const openChat = async () => {
    const chat = await mutation.execute(() =>
      assistantApi.create({
        agentId: agent.id,
        provider: agent.provider,
        model: agent.model,
      }),
    );
    if (chat) router.push(`/assistant?chat=${encodeURIComponent(chat.id)}`);
  };
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Icon name={agent.provider} className="size-3.5" />
          {ASSISTANT_PROVIDER_LABELS[agent.provider]}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Icon name="shield-check" className="size-4" />
          {agent.readOnly ? "Read only" : "Approved actions"} · {agent.grants.length}{" "}
          {agent.grants.length === 1 ? "resource" : "resources"}
        </span>
      </div>
      <div className="flex flex-wrap gap-3">
        {!agent.archived && (
          <Button disabled={mutation.busy} onClick={() => void openChat()}>
            <Icon
              name={mutation.busy ? "spinner" : "message"}
              className={mutation.busy ? "animate-spin" : ""}
            />
            {mutation.busy ? "Opening…" : "Open chat"}
            <Icon name="arrow-right" />
          </Button>
        )}
        <Button asChild variant="secondary">
          <AgentLink href={`/assistant/agents/${agent.id}/edit`}>
            <Icon name="settings" /> Edit agent & access
          </AgentLink>
        </Button>
      </div>
      {mutation.error && (
        <p role="alert" className="text-sm text-danger">
          {mutation.error}
        </p>
      )}
      <div className="space-y-8">
        <section>
          <h3 className="mb-4 text-sm font-medium">
            Recent chats <span className="ms-1.5 text-muted-foreground">{agent.tasks.length}</span>
          </h3>
          {!agent.tasks.length ? (
            <div className="rounded-2xl bg-card p-6">
              <p className="text-sm text-muted-foreground">
                Open a chat to give this agent its first task. Its work and your follow-ups stay
                together.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {agent.tasks.map((task) => (
                <Link
                  key={task.id}
                  href={`/assistant?chat=${task.id}`}
                  className="group flex items-center gap-3 rounded-xl px-3 py-4 transition-colors hover:bg-card"
                >
                  <Icon
                    name={task.automationRunId ? "workflow" : "message"}
                    className="size-4 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
                  {isAssistantActive(task.state) || task.state === "error" ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {isAssistantActive(task.state)
                        ? "Working"
                        : task.state === "error"
                          ? "Needs attention"
                          : ""}
                    </span>
                  ) : null}
                  <Icon name="arrow-up-right" className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
      <div className="space-y-6 text-sm">
        {!agent.archived && (
          <>
            <Link
              href={`/assistant/automations/new?agent=${agent.id}`}
              className="group flex items-center gap-4 rounded-2xl bg-card p-5 hover:bg-muted/60"
            >
              <Icon name="workflow" className="size-5 shrink-0 text-muted-foreground" />
              <div className="flex-1">
                <p className="font-medium">Put it to work automatically</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Choose an event that starts a task for this agent.
                </p>
              </div>
              <Icon name="arrow-right" className="size-4 shrink-0" />
            </Link>
            <button
              className="text-xs text-muted-foreground hover:text-danger"
              onClick={() => setArchiving(true)}
            >
              Archive agent
            </button>
          </>
        )}
      </div>
      <AssistantDialog
        isOpen={archiving}
        onClose={() => setArchiving(false)}
        closable={!mutation.busy}
        label="Archive agent"
        width="460px"
        maxWidth="calc(100vw - 24px)"
      >
        <div className="p-7 pt-12">
          <h2 className="text-xl font-medium">Archive {agent.name}?</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Active tasks will stop and its automations will be paused. You can still read its
            conversations.
          </p>
          {mutation.error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {mutation.error}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-3">
            <Button variant="ghost" disabled={mutation.busy} onClick={() => setArchiving(false)}>
              Cancel
            </Button>
            <Button
              disabled={mutation.busy}
              onClick={() =>
                void mutation
                  .execute(() => assistantAgentsApi.archive(agent.id, agent.revision))
                  .then((result) => {
                    if (result) {
                      setArchiving(false);
                      onRefresh();
                      navigation?.changed();
                    }
                  })
              }
            >
              {mutation.busy ? "Archiving…" : "Archive agent"}
            </Button>
          </div>
        </div>
      </AssistantDialog>
    </div>
  );
}
