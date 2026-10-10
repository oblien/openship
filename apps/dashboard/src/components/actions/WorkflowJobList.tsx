"use client";

import { useId } from "react";
import type { ActionPlanView } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import type { workflowJobs } from "./workflow-editor";
import type { WorkflowExpandedSteps } from "./WorkflowSteps";
import { WorkflowJobEditor } from "./WorkflowJobEditor";
import type { WorkflowEdit } from "./workflow-editor";
import { workflowJobTargetLabel } from "./workflow-graph";

/** A draft outline, not execution progress; dependencies remain explicit. */
export function WorkflowJobList({
  plan,
  jobs,
  expandedJobs,
  onToggleJob,
  source,
  edit,
  expandedSteps,
  onExpandedStepsChange,
  onEditYaml,
}: {
  plan: ActionPlanView;
  jobs: ReturnType<typeof workflowJobs>;
  expandedJobs: string[];
  onToggleJob: (id: string) => void;
  source: string;
  edit: WorkflowEdit;
  expandedSteps: WorkflowExpandedSteps;
  onExpandedStepsChange: (expanded: WorkflowExpandedSteps) => void;
  onEditYaml: (id: string) => void;
}) {
  const { t } = useI18n();
  const e = t.actions.editor;
  const prefix = useId();
  return (
    <ol className="p-3 sm:p-5" aria-label={t.actions.list}>
      {plan.jobs.map((job, index) => {
        const draftJob = jobs.find((item) => item.id === job.id);
        const value = draftJob?.value;
        const steps = Array.isArray(value?.steps) ? value.steps : [];
        const expanded = expandedJobs.includes(job.id);
        const stepsId = `${prefix}-${job.id}-steps`;
        return (
          <li className="relative pb-3 last:pb-0" key={job.id}>
            {index < plan.jobs.length - 1 && (
              <span aria-hidden className="absolute bottom-0 start-[25px] top-10 w-px bg-border" />
            )}
            <button
              type="button"
              aria-label={`${e.editJob}: ${job.name}`}
              aria-expanded={expanded}
              aria-controls={stepsId}
              onClick={() => onToggleJob(job.id)}
              className={`relative flex w-full items-start gap-3 rounded-xl p-3 text-start transition-colors focus-visible:outline-2 focus-visible:outline-ring ${expanded ? "bg-muted/60" : "hover:bg-muted/40"}`}
            >
              <span className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-card text-info/80">
                <Icon name="play-circle" className="size-5" />
              </span>
              <span className="min-w-0 flex-1 py-0.5">
                <span className="block truncate text-sm font-medium text-foreground">
                  {job.name}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="truncate">
                    {workflowJobTargetLabel(job, t.actions.controller.reusable)}
                  </span>
                  {!job.uses && (
                    <span>
                      {e.steps} · {steps.length}
                    </span>
                  )}
                </span>
                {!!job.needs.length && (
                  <span className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Icon name="git-branch" className="size-3 shrink-0" />
                    {e.dependsOn}
                    {job.needs.map((id) => (
                      <span
                        key={id}
                        className="max-w-full truncate rounded bg-muted/60 px-1.5 py-0.5"
                      >
                        {plan.jobs.find((item) => item.id === id)?.name ?? id}
                      </span>
                    ))}
                  </span>
                )}
              </span>
              <Icon
                name="chevron-down"
                className={`mt-1.5 size-3.5 shrink-0 text-muted-foreground ${expanded ? "rotate-180" : ""}`}
              />
            </button>
            <div
              id={stepsId}
              hidden={!expanded}
              className="ms-[25px] border-s border-border py-2 ps-4 pe-3"
            >
              {expanded && draftJob && (
                <WorkflowJobEditor
                  source={source}
                  job={draftJob}
                  jobs={jobs}
                  edit={edit}
                  expandedSteps={expandedSteps}
                  onExpandedStepsChange={onExpandedStepsChange}
                  onEditYaml={onEditYaml}
                  inline
                />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
