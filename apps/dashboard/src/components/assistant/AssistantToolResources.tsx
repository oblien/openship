"use client";

import { AgentLink } from "./AgentLink";
import { Icon } from "@repo/ui/icons";
import type { ToolResultView } from "./tool-presentation";
import { AssistantChatAppSetup } from "./AssistantChatAppSetup";
import { ChannelLogo } from "@/components/ui/ChannelLogo";
import { AgentAvatar } from "./AgentAvatar";
import { AssistantAutomationResources } from "./AssistantAutomationResources";

/** Inline preview and inspector share the same resource links and field selection. */
export function AssistantToolResources({
  view,
  compact = false,
  onDetails,
  onNavigate,
}: {
  view: ToolResultView;
  compact?: boolean;
  onDetails?(id?: string): void;
  onNavigate?(): void;
}) {
  if (view.kind === "automations")
    return (
      <AssistantAutomationResources view={view} onDetails={onDetails} onNavigate={onNavigate} />
    );
  const shown = compact ? view.items.slice(0, 4) : view.items;
  return (
    <section
      aria-label={`${view.title} from tool`}
      className="min-w-0 rounded-2xl bg-card p-4 sm:p-5"
    >
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className="font-medium text-foreground">{view.title}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{view.total}</span>
        {onDetails && (
          <button
            type="button"
            onClick={() => onDetails()}
            className="ms-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Details <Icon name="expand" className="size-3.5" />
          </button>
        )}
      </div>
      {shown.length ? (
        <div className="grid gap-1">
          {shown.map((item) => (
            <div
              key={item.id}
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl py-3"
            >
              {item.agentIcon ? (
                <AgentAvatar icon={item.agentIcon} agentId={item.id} className="size-10" />
              ) : (
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background text-muted-foreground">
                  {item.setup ? (
                    <ChannelLogo
                      kind={item.setup.provider === "teams" ? "msteams" : item.setup.provider}
                      className="size-6"
                    />
                  ) : (
                    <Icon name={view.icon} className="size-5" />
                  )}
                </span>
              )}
              <div className="min-w-0 flex-1 basis-32">
                <p className="truncate text-sm font-medium text-foreground" title={item.title}>
                  {item.title}
                </p>
                {item.description && (
                  <p
                    className="mt-1 truncate text-xs text-muted-foreground"
                    title={item.description}
                  >
                    {item.description}
                  </p>
                )}
              </div>
              {item.status && (
                <span
                  className={`max-w-full rounded-md px-2 py-1 text-xs ${item.tone === "danger" ? "bg-[var(--st-danger-bg)] text-danger" : item.tone === "info" ? "bg-[var(--st-info-bg)] text-[var(--st-info-fg)]" : "bg-background text-muted-foreground"}`}
                >
                  {item.status}
                </span>
              )}
              {item.setup ? (
                <AssistantChatAppSetup item={{ ...item, setup: item.setup }} />
              ) : (
                item.href && (
                  <AgentLink
                    prefetch={false}
                    href={item.href}
                    onNavigate={onNavigate}
                    aria-label={`${item.action}: ${item.title}`}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {item.action} <Icon name="arrow-right" className="size-3.5" />
                  </AgentLink>
                )
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="py-3 text-sm text-muted-foreground">{view.empty}</p>
      )}
      {view.items.length > shown.length && onDetails && (
        <button
          type="button"
          onClick={() => onDetails()}
          className="mt-2 rounded-lg py-2 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          View all {view.items.length} returned items{" "}
          <Icon name="chevron-right" className="ms-1 inline size-3" />
        </button>
      )}
      {view.total > view.items.length && (
        <p className="mt-3 text-xs text-muted-foreground">
          {view.items.length} of {view.total} returned by this call.
        </p>
      )}
      {view.note && view.items.length > 0 && (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{view.note}</p>
      )}
    </section>
  );
}
