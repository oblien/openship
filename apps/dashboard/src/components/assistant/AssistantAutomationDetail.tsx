"use client";

import { useRef, useState } from "react";
import { type AssistantAutomation, type AssistantAutomationRun } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import {
  AutomationRunBadge,
  AutomationResultLink,
  AutomationRunReview,
} from "./AutomationRunReview";
import { AutomationSteps } from "./AutomationSteps";
import { AutomationEditorData } from "./AutomationEditorPage";
import { AutomationDetailSkeleton } from "./AutomationSkeleton";

export function AssistantAutomationDetail({
  flow,
  runs,
  paused,
  loading,
  error,
  onChat,
  onRefresh,
  clientId,
  agentName,
}: {
  flow?: AssistantAutomation;
  runs: AssistantAutomationRun[];
  paused: boolean;
  loading: boolean;
  error: string | null;
  onChat(id: string): void;
  onRefresh(): void;
  clientId: string | null;
  agentName?: string;
}) {
  const [review, setReview] = useState<AssistantAutomationRun | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const stepsRef = useRef<HTMLDivElement>(null);
  const finishEditing = () => {
    const step = editing;
    setEditing(null);
    requestAnimationFrame(() =>
      stepsRef.current
        ?.querySelector<HTMLButtonElement>(`[data-automation-step="${step}"]`)
        ?.focus({ preventScroll: true }),
    );
  };
  if (!flow && loading && !error) return <AutomationDetailSkeleton />;
  if (!flow)
    return (
      <div className="m-auto max-w-md p-6 text-center">
        <Icon name="workflow" className="mx-auto mb-4 size-8 text-muted-foreground" />
        <p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">
          {error ?? "This automation is no longer available in this workspace."}
        </p>
        {error && (
          <Button variant="secondary" size="sm" className="mt-4" onClick={onRefresh}>
            Try again
          </Button>
        )}
      </div>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto w-full max-w-3xl px-1 pb-8 pt-2">
        <div ref={stepsRef}>
          {editing === null ? (
            <>
              <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="truncate text-sm text-foreground">{flow.projectName}</span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Icon name={!flow.enabled || paused ? "pause" : "play"} className="size-3" />
                    {paused ? "All automations paused" : flow.enabled ? "Enabled" : "Paused"}
                  </span>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setEditing(0)}>
                  <Icon name="settings" />
                  Edit settings
                </Button>
              </div>
              <AutomationSteps flow={{ ...flow, agentName }} onSelect={setEditing} />
              <p className="mt-3 text-xs text-muted-foreground">
                Up to {flow.dailyLimit} runs/day · {flow.cooldownMinutes} min apart
              </p>
            </>
          ) : (
            <AutomationEditorData
              id={flow.id}
              preview={{ ...flow, agentName, paused }}
              clientId={clientId}
              embedded
              initialStep={editing}
              onCancel={finishEditing}
              onSaved={() => {
                finishEditing();
                onRefresh();
              }}
            />
          )}
        </div>
        {editing === null && (
          <section
            aria-label="Automation run history"
            className="mt-8 border-t border-border/40 pt-5"
          >
            <h2 className="mb-4 text-sm font-medium">
              Run history{" "}
              {runs.length > 0 && <span className="ms-1 text-muted-foreground">{runs.length}</span>}
            </h2>
            {!runs.length && (
              <p className="text-sm leading-6 text-muted-foreground">
                No runs yet. Investigations will appear here when this automation runs.
              </p>
            )}
            <div className="space-y-3">
              {runs.map((run) => (
                <article key={run.id} className="rounded-2xl bg-card p-4 sm:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      {new Date(run.createdAt).toLocaleString()}
                    </p>
                    <AutomationRunBadge run={run} />
                  </div>
                  <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">
                    {run.message || "Investigation queued."}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <AutomationResultLink run={run} />
                    {run.conversationId && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onChat(run.conversationId!)}
                      >
                        <Icon name="message" />
                        Open investigation
                        <Icon name="arrow-right" />
                      </Button>
                    )}
                    {run.state === "approval" && (
                      <Button size="sm" onClick={() => setReview(run)}>
                        Review action
                        <Icon name="arrow-right" />
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
        {error && (
          <p role="alert" className="mt-4 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
      {review && (
        <AutomationRunReview
          run={review}
          onClose={() => setReview(null)}
          onDecided={() => {
            setReview(null);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}
