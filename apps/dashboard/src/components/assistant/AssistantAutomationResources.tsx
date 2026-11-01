"use client";

import { useId, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { assistantAutomationsApi } from "@/lib/api/assistant-automations";
import { useScopedResource } from "@/hooks/use-scoped-resource";
import { AutomationSteps } from "./AutomationSteps";
import { AgentLink } from "./AgentLink";
import { presentToolResult, type ToolResultView } from "./tool-presentation";
import { cn } from "@/lib/utils";

const noDetails = async () => null;

export function AssistantAutomationResources({
  view,
  onDetails,
  onNavigate,
}: {
  view: ToolResultView;
  onDetails?: (id?: string) => void;
  onNavigate?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  // ID-only receipts are resolved through the same scoped API as the editor.
  // Never fill a successful result from the model's unconfirmed request arguments.
  const needsDetails = expanded && view.items.some((item) => !item.automation);
  const current = useScopedResource(needsDetails ? assistantAutomationsApi.overview : noDetails);
  const resolved = current.data
    ? presentToolResult({
        id: "flow-details",
        name: "get_assistant_automations",
        input: {},
        output: JSON.stringify(current.data),
      })
    : null;
  const receipt = view.items.length === 1 ? view.items[0] : null;
  const only = receipt
    ? receipt.automation
      ? receipt
      : (resolved?.items.find((item) => item.id === receipt.id) ?? receipt)
    : null;
  if (!view.items.length) return <p className="text-sm text-muted-foreground">{view.empty}</p>;
  return (
    <section
      className="min-w-0 overflow-hidden rounded-xl bg-card"
      aria-label="Automations from tool"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-start transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info-bg text-info">
          <Icon name="workflow" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {only?.title ?? `${view.items.length} automations`}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {only
              ? [only.description, only.status].filter(Boolean).join(" · ")
              : view.items.map((item) => item.title).join(" · ")}
          </span>
        </span>
        <Icon
          name="chevron-down"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      <div id={contentId} hidden={!expanded}>
        {expanded && (
          <div className="divide-y divide-border/40 border-t border-border/40">
            {view.items.map((receipt) => {
              const updated = !receipt.automation
                ? resolved?.items.find((item) => item.id === receipt.id)
                : undefined;
              const item = updated ?? receipt;
              return (
                <article key={item.id} className="min-w-0 overflow-hidden" aria-label={item.title}>
                  {!only && (
                    <header className="flex flex-wrap items-start gap-3 px-4 pt-4 sm:px-5">
                      <div className="min-w-0 flex-1 basis-36">
                        <h3 className="text-sm font-medium leading-5 text-foreground">
                          {item.title}
                        </h3>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {item.description && <span>{item.description}</span>}
                          {item.status && (
                            <span className="inline-flex items-center gap-1">
                              <Icon
                                name={item.status === "Enabled" ? "play" : "pause"}
                                className="size-3"
                              />
                              {item.status}
                            </span>
                          )}
                          {updated && <span>Current configuration</span>}
                        </div>
                      </div>
                    </header>
                  )}
                  {only && updated && (
                    <p className="px-4 pt-3 text-xs text-muted-foreground">Current configuration</p>
                  )}
                  <div className="p-3 pt-4">
                    {item.automation ? (
                      <AutomationSteps flow={item.automation} />
                    ) : (
                      <p className="px-2 py-4 text-xs text-muted-foreground">
                        {current.loading
                          ? "Loading flow…"
                          : "Open the flow to review its configuration."}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3 px-4 pb-3">
                    {item.href && (
                      <AgentLink
                        href={item.href}
                        prefetch={false}
                        onNavigate={onNavigate}
                        aria-label={`Review flow: ${item.title}`}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg py-1 text-xs font-medium text-foreground hover:text-info focus-visible:outline-2 focus-visible:outline-info"
                      >
                        Review flow <Icon name="arrow-right" className="size-3.5" />
                      </AgentLink>
                    )}
                    {onDetails && (
                      <button
                        type="button"
                        onClick={() => onDetails(item.id)}
                        className="rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-info"
                      >
                        Tool details <Icon name="expand" className="ms-1 inline size-3" />
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
