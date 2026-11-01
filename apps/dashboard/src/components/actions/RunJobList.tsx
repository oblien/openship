"use client";

import type { ActionJobView } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { ActionStatus } from "./ActionStatus";
import type { jobProgress } from "./job-progress";

export type RunStep = ReturnType<typeof jobProgress>[number];

export function RunJobList({
  jobs,
  progress,
  selectedJob,
  selectedStep,
  expanded,
  onToggle,
  onSelect,
}: {
  jobs: ActionJobView[];
  progress: ReadonlyMap<string, RunStep[]>;
  selectedJob?: string;
  selectedStep: string | null;
  expanded: readonly string[];
  onToggle: (id: string) => void;
  onSelect: (job: string, step?: string | null) => void;
}) {
  const { t } = useI18n();
  const a = t.actions;
  const renderJobs = (rows: ActionJobView[]): React.ReactNode =>
    rows.map((job) => {
      const steps = progress.get(job.id) ?? [];
      const children = jobs.filter((row) => row.parentJobId === job.id);
      const open = expanded.includes(job.id);
      const selected = job.id === selectedJob;
      const status =
        job.phase === "provisioning" && job.status === "running" ? "provisioning" : job.status;
      return (
        <div key={job.id}>
          <div
            className={`flex items-center rounded-lg ${selected ? "bg-muted/60" : "hover:bg-muted/40"}`}
          >
            <button
              type="button"
              onClick={() => onSelect(job.id)}
              aria-current={selected && !selectedStep ? "step" : undefined}
              aria-label={job.name}
              aria-description={a.status[status]}
              className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-3 py-3 text-start focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="mt-0.5">
                <ActionStatus status={status} iconOnly />
              </span>
              <span className="min-w-0 flex-1 break-words text-sm font-medium">{job.name}</span>
            </button>
            <button
              type="button"
              onClick={() => onToggle(job.id)}
              aria-expanded={open}
              aria-label={`${open ? a.editor.collapseJob : a.editor.expandJob}: ${job.name}`}
              className="me-1 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Icon name="chevron-down" className={`size-4 ${open ? "rotate-180" : ""}`} />
            </button>
          </div>
          {open && (
            <div className="ms-5 border-s border-border/60 pb-2 ps-2">
              {job.reusable && children.length ? (
                renderJobs(children)
              ) : steps.length ? (
                steps.map((step, index) => (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => onSelect(job.id, step.id)}
                    aria-label={`${a.runView.stepLogs}: ${step.name}`}
                    aria-description={a.status[step.status]}
                    aria-current={selected && step.id === selectedStep ? "step" : undefined}
                    className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-start text-xs focus-visible:outline-2 focus-visible:outline-ring ${selected && step.id === selectedStep ? "bg-info/10 text-foreground" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"}`}
                  >
                    <span className="mt-0.5">
                      <ActionStatus status={step.status} iconOnly />
                    </span>
                    <span className="min-w-0 flex-1 break-words">{step.name}</span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
                  {a.stepsPending}
                </p>
              )}
            </div>
          )}
        </div>
      );
    });
  return (
    <nav aria-label={a.list} className="min-h-0 space-y-1 overflow-y-auto p-2">
      {renderJobs(
        jobs.filter(
          (row) => !row.parentJobId || !jobs.some((parent) => parent.id === row.parentJobId),
        ),
      )}
      {!jobs.length && <p className="p-3 text-xs text-muted-foreground">{a.queuedLogs}</p>}
    </nav>
  );
}
