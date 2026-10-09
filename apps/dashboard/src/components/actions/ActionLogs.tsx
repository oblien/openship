"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { actionsApi } from "@/lib/api/actions";
import { getApiErrorMessage } from "@/lib/api/client";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Icon } from "@repo/ui/icons";
import { ActionError, ActionStatus } from "./ActionStatus";
import type { ActionJobView } from "@repo/contracts";
import { jobProgress, type JobEvent } from "./job-progress";

export function ActionLogs({ job }: { job: ActionJobView }) {
  const jobId = job.id;
  const { t } = useI18n();
  const a = t.actions;
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const follow = useRef(true);
  const container = useRef<HTMLDivElement>(null);
  const cursor = useRef(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 2000;
      try {
        const response = await actionsApi.events(jobId, cursor.current);
        if (!active) return;
        setError(null);
        const after = cursor.current;
        cursor.current = response.next;
        if (response.events.length)
          setEvents((previous) => [
            ...previous,
            ...response.events.filter((event) => event.sequence > after),
          ]);
        if (response.complete) return;
        if (response.events.length >= 250) delay = 50;
      } catch (error) {
        if (active) setError(getApiErrorMessage(error));
        delay = 5000;
      }
      if (active) timer = setTimeout(poll, delay);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [jobId, revision]);
  useEffect(() => {
    if (follow.current && container.current)
      container.current.scrollTop = container.current.scrollHeight;
  }, [events]);
  const text = useMemo(
    () =>
      events
        .filter((event) => event.type === "log")
        .map((event) => `${event.step ? `[${event.step}] ` : ""}${event.message ?? ""}`)
        .join("\n"),
    [events],
  );
  const steps = useMemo(() => jobProgress(events, job), [events, job.steps, job.status]);
  return (
    <div className="grid min-w-0 items-start gap-5 @min-[960px]:grid-cols-[240px_minmax(0,1fr)]">
      <div className="min-w-0 space-y-4">
        <h3 className="text-sm font-medium">{a.steps}</h3>
        {steps.length ? (
          steps.map((step) => (
            <div key={step.id} className="space-y-1.5 rounded-lg bg-background px-3 py-2.5">
              <p className="truncate text-xs font-medium" title={step.name}>
                {step.name}
              </p>
              <ActionStatus status={step.status} />
            </div>
          ))
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">{a.stepsPending}</p>
        )}
        {!!Object.keys(job.outputs).length && (
          <details className="rounded-xl bg-background p-3">
            <summary className="cursor-pointer text-xs font-medium">{a.outputs}</summary>
            <dl className="mt-3 space-y-2">
              {Object.entries(job.outputs).map(([key, value]) => (
                <div key={key}>
                  <dt className="font-mono text-xs text-muted-foreground">{key}</dt>
                  <dd className="mt-1 break-all font-mono text-xs">{value}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
      <div className="min-w-0 space-y-3">
        <ActionError message={error} onRetry={() => setRevision((value) => value + 1)} />
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{a.logs}</h3>
          <Button
            type="button"
            size="sm"
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
        </div>
        <div
          ref={container}
          onScroll={(event) => {
            const element = event.currentTarget;
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          }}
          className="h-[360px] min-w-0 overflow-auto rounded-xl bg-background px-4 py-3"
          tabIndex={0}
          role="region"
          aria-label={a.logs}
          dir="ltr"
        >
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-foreground/80">
            {text || a.queuedLogs}
          </pre>
        </div>
      </div>
    </div>
  );
}
