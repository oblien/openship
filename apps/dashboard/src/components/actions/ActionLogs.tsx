"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ActionJobView } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Icon } from "@repo/ui/icons";
import { ActionError, ActionStatus } from "./ActionStatus";
import type { JobEvent } from "./job-progress";
import type { RunStep } from "./RunJobList";

/** Presentation only: the workspace owns the single journal for both views. */
export function ActionLogs({
  job,
  events,
  loading,
  error,
  liveGitHub,
  step,
  onClearStep,
  onRetry,
}: {
  job: ActionJobView;
  events: JobEvent[];
  loading: boolean;
  error: string | null;
  liveGitHub: boolean;
  step: RunStep | undefined;
  onClearStep: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const a = t.actions;
  const follow = useRef(true);
  const container = useRef<HTMLDivElement>(null);
  const { text, scoped } = useMemo(() => {
    const logs = events.filter((event) => event.type === "log");
    const tagged = logs.some((event) => event.stepId);
    const scoped = !!step && (!job.externalUrl || tagged);
    const selected = scoped ? logs.filter((event) => event.stepId === step.id) : logs;
    // GitHub returns consecutive chunks of the complete log. Inserting newlines
    // between them would split arbitrary lines and corrupt the displayed output.
    const rawGitHub = !!job.externalUrl && !tagged;
    return {
      scoped,
      text: selected
        .map((event) => `${!scoped && event.step ? `[${event.step}] ` : ""}${event.message ?? ""}`)
        .join(rawGitHub ? "" : "\n"),
    };
  }, [events, step?.id, job.externalUrl]);
  useEffect(() => {
    follow.current = true;
  }, [job.id, step?.id]);
  useEffect(() => {
    if (follow.current && container.current)
      container.current.scrollTop = container.current.scrollHeight;
  }, [text, job.id, step?.id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {step && <ActionStatus status={step.status} iconOnly />}
          <h3 className="min-w-0 break-words text-sm font-medium">
            {step?.name ?? a.runView.allLogs}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {step && (
            <Button size="sm" variant="ghost" onClick={onClearStep}>
              {a.runView.allLogs}
            </Button>
          )}
          {!liveGitHub && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={a.followLogs}
              title={a.followLogs}
              onClick={() => {
                follow.current = true;
                if (container.current) container.current.scrollTop = container.current.scrollHeight;
              }}
            >
              <Icon name="arrow-down" />
            </Button>
          )}
        </div>
      </div>
      {liveGitHub ? (
        <div className="flex min-h-56 flex-1 flex-col items-center justify-center gap-4 rounded-xl bg-background/70 p-5 text-center">
          <Icon name="github" className="size-6 text-muted-foreground" />
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
            {a.controller.liveLogs}
          </p>
          <Button asChild variant="secondary" size="sm">
            <a href={job.externalUrl!} target="_blank" rel="noopener noreferrer">
              {a.controller.watchLiveLogs}
              <Icon name="arrow-up-right" />
            </a>
          </Button>
        </div>
      ) : (
        <>
          <ActionError message={error} onRetry={onRetry} />
          {step && !scoped && events.length > 0 && (
            <p className="text-xs text-muted-foreground">{a.runView.fullJobLog}</p>
          )}
          <div
            ref={container}
            onScroll={(event) => {
              const element = event.currentTarget;
              follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
            }}
            className="min-h-[320px] min-w-0 flex-1 overflow-auto rounded-xl bg-background/80 px-4 py-3 @min-[960px]/run:min-h-0"
            tabIndex={0}
            role="region"
            aria-label={a.logs}
            aria-busy={loading}
            dir="ltr"
          >
            {loading && !text ? (
              <span className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                <Icon name="spinner" className="size-3.5 motion-safe:animate-spin" />
                {a.runView.loadingLogs}
              </span>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-foreground/90">
                {text || (step ? a.runView.noStepLogs : a.queuedLogs)}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}
