"use client";

import { useEffect, useState } from "react";
import type { ActionJobView, ActionRunView } from "@repo/contracts";
import { actionFinished, type ActionStatus as Status } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/Tabs";
import { useI18n } from "@/components/i18n-provider";
import { ActionError, ActionStatus } from "./ActionStatus";
import { ActionLogs } from "./ActionLogs";
import { RunJobList } from "./RunJobList";
import { RunApproval, runApprovalState } from "./RunApproval";
import { WorkflowGraph } from "./WorkflowGraph";
import { WorkflowExpandButton } from "./WorkflowExpandButton";
import { workflowStepNodeId, workflowVisibleJob } from "./workflow-graph";
import { jobProgress } from "./job-progress";
import { useActionLogEvents } from "./useActionLogEvents";

export type RunWorkspaceView = "list" | "graph" | "approvals";

export function RunWorkspace({
  run,
  job,
  selectedStep,
  view,
  onSelect,
  onViewChange,
  approving,
  onApprove,
}: {
  run: ActionRunView;
  job: ActionJobView | undefined;
  selectedStep: string | null;
  view: RunWorkspaceView;
  onSelect: (job: string, step?: string | null) => void;
  onViewChange: (view: RunWorkspaceView) => void;
  approving: boolean;
  onApprove: () => void;
}) {
  const { t } = useI18n();
  const a = t.actions;
  const logs = useActionLogEvents(job);
  const approval = runApprovalState(run);
  const approvalNotice =
    approval === "required" ? a.access.waiting : approval === "blocked" ? a.access.blocked : null;
  const [lastLogView, setLastLogView] = useState<"list" | "graph">(
    view === "graph" ? "graph" : "list",
  );
  const logView = view === "approvals" ? lastLogView : view;
  const [graphVisited, setGraphVisited] = useState(view === "graph");
  useEffect(() => {
    if (view !== "approvals") setLastLogView(view);
    if (view === "graph") setGraphVisited(true);
  }, [view]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [topologyExpanded, setTopologyExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (job)
      setExpanded((current) => {
        const next = { ...current, [job.id]: current[job.id] ?? true };
        let parent = job.parentJobId;
        while (parent) {
          next[parent] = true;
          parent = run.jobs.find((row) => row.id === parent)?.parentJobId;
        }
        return next;
      });
  }, [job?.id]);
  const progress = new Map(
    run.jobs.map((row) => [row.id, jobProgress(logs.eventsFor(row.id), row)]),
  );
  const steps = job ? (progress.get(job.id) ?? []) : [];
  const step = steps.find((step) => step.id === selectedStep);
  const expandedJobs = run.jobs
    .filter((row) => expanded[row.id] ?? (row.id === job?.id || !!row.reusable))
    .map((row) => row.id);
  const select = (job: string, step?: string | null) => {
    setExpanded((current) => ({ ...current, [job]: true }));
    onSelect(job, step);
  };
  const representatives = new Map(
    run.plan.jobs.map((node) => [node.id, workflowVisibleJob(run.jobs, node.id, job?.id)]),
  );
  const definitions = run.plan.jobs.map((node) => {
    const row = representatives.get(node.id);
    return {
      id: node.id,
      value: {
        steps: (row ? (progress.get(row.id) ?? []) : []).map((step) => ({ name: step.name })),
      },
    };
  });
  const expandable = definitions
    .filter((node) => node.value.steps.length > 0)
    .map((node) => node.id);
  const single = run.plan.jobs.length === 1 ? expandable[0] : undefined;
  const expandedTopology = expandable.filter((id) => topologyExpanded[id] ?? id === single);
  const allExpanded =
    logView === "list"
      ? run.jobs.every((row) => expandedJobs.includes(row.id))
      : expandable.every((id) => expandedTopology.includes(id));
  const stepStatuses: Record<string, Status> = {};
  for (const [key, row] of representatives) {
    if (row)
      (progress.get(row.id) ?? []).forEach((step, index) => {
        stepStatuses[workflowStepNodeId(key, index)] = step.status;
      });
  }
  const selectedIndex = step ? steps.findIndex((row) => row.id === step.id) : -1;
  const matrixJobs = job ? run.jobs.filter((row) => row.jobKey === job.jobKey) : [];

  return (
    <section className="@container/run space-y-3" data-testid="run-workspace">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          tabs={[
            { key: "list", label: a.list, icon: "list" },
            { key: "graph", label: a.editor.topology, icon: "topology" },
            {
              key: "approvals",
              label: a.runView.approvals,
              leading: (
                <span
                  className={approvalNotice ? "inline-flex text-warning" : "inline-flex"}
                  title={approvalNotice ?? undefined}
                >
                  <Icon name="shield" className="size-4" />
                  {approvalNotice && <span className="sr-only">{approvalNotice}</span>}
                </span>
              ),
            },
          ]}
          value={view}
          onChange={onViewChange}
          idPrefix="workflow-view"
          ariaLabel={a.editor.view}
          className="border-0"
        />
        {view !== "approvals" &&
          (view === "list" ? run.jobs.length > 0 : expandable.length > 0) && (
            <WorkflowExpandButton
              expanded={allExpanded}
              onClick={() => {
                if (view === "list")
                  setExpanded(Object.fromEntries(run.jobs.map((row) => [row.id, !allExpanded])));
                else
                  setTopologyExpanded(
                    Object.fromEntries(expandable.map((id) => [id, !allExpanded])),
                  );
              }}
            />
          )}
      </div>
      {view === "approvals" && (
        <div
          role="tabpanel"
          id="workflow-view-panel-approvals"
          aria-labelledby="workflow-view-tab-approvals"
        >
          <RunApproval run={run} busy={approving} onApprove={onApprove} />
        </div>
      )}
      <div
        hidden={view === "approvals"}
        className={`${view === "approvals" ? "hidden" : "grid"} min-w-0 items-stretch gap-4 @min-[960px]/run:h-[calc(100dvh-265px)] @min-[960px]/run:min-h-[520px] @min-[960px]/run:max-h-[900px] ${logView === "list" ? "@min-[960px]/run:grid-cols-[300px_minmax(0,1fr)]" : "@min-[960px]/run:grid-cols-[minmax(0,1fr)_minmax(380px,0.85fr)]"}`}
      >
        <div
          className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl bg-card"
          role="tabpanel"
          id={`workflow-view-panel-${logView}`}
          aria-labelledby={`workflow-view-tab-${logView}`}
        >
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-xs text-muted-foreground">
            <span>{logView === "list" ? a.runView.jobs : a.graph}</span>
            <span className="tabular-nums">
              {run.jobs.filter((job) => actionFinished(job.status)).length} / {run.jobs.length}
            </span>
          </div>
          <div
            className={
              logView === "list"
                ? "min-h-0 max-h-[320px] flex-1 overflow-y-auto @min-[960px]/run:max-h-none"
                : "hidden"
            }
          >
            <RunJobList
              jobs={run.jobs}
              progress={progress}
              selectedJob={job?.id}
              selectedStep={selectedStep}
              expanded={expandedJobs}
              onToggle={(id) =>
                setExpanded((current) => ({ ...current, [id]: !expandedJobs.includes(id) }))
              }
              onSelect={select}
            />
          </div>
          <div
            className={
              logView === "graph"
                ? "relative h-[420px] min-h-0 flex-none @min-[960px]/run:h-auto @min-[960px]/run:flex-1"
                : "hidden"
            }
          >
            {(graphVisited || logView === "graph") && (
              <WorkflowGraph
                plan={run.plan}
                run={run}
                selected={job?.id}
                onSelect={(id) => select(id)}
                className="absolute inset-0 min-w-0 overflow-hidden"
                jobDetails={{
                  jobs: definitions,
                  expandedJobs: expandedTopology,
                  onToggleJob: (id) =>
                    setTopologyExpanded((current) => ({
                      ...current,
                      [id]: !expandedTopology.includes(id),
                    })),
                  onSelectStep: (key, index) => {
                    const row = representatives.get(key);
                    const step = row ? progress.get(row.id)?.[index] : undefined;
                    if (row && step) select(row.id, step.id);
                  },
                  selectedStep:
                    job && selectedIndex >= 0 ? { jobId: job.jobKey, index: selectedIndex } : null,
                  stepStatuses,
                }}
              />
            )}
          </div>
        </div>
        {job ? (
          <section
            className="flex min-h-[440px] min-w-0 flex-col gap-4 rounded-2xl bg-card p-4 @min-[960px]/run:min-h-0"
            aria-label={a.runView.jobLogs}
          >
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="break-words text-base font-medium">{job.name}</h2>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  <bdi>{job.labels.join(" · ")}</bdi>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <ActionStatus
                  status={
                    job.phase === "provisioning" && job.status === "running"
                      ? "provisioning"
                      : job.status
                  }
                />
                {job.externalUrl && !logs.liveGitHub && (
                  <Button asChild variant="ghost" size="icon">
                    <a
                      href={job.externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={a.controller.openGitHub}
                      title={a.controller.openGitHub}
                    >
                      <Icon name="github" />
                    </a>
                  </Button>
                )}
              </div>
            </header>
            {logView === "graph" && matrixJobs.length > 1 && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={a.matrix}>
                {matrixJobs.map((row) => (
                  <Button
                    key={row.id}
                    size="sm"
                    variant={row.id === job.id ? "secondary" : "ghost"}
                    onClick={() => select(row.id)}
                    aria-pressed={row.id === job.id}
                  >
                    {row.name}
                  </Button>
                ))}
              </div>
            )}
            <ActionError message={job.status === "cancelled" ? null : job.error} />
            {job.checkError && (
              <p className="text-xs text-muted-foreground" title={job.checkError}>
                {a.checkPending}
              </p>
            )}
            <ActionLogs
              job={job}
              events={logs.events}
              loading={logs.loading}
              error={logs.error}
              liveGitHub={logs.liveGitHub}
              step={step}
              onClearStep={() => select(job.id)}
              onRetry={logs.refresh}
            />
            {!!Object.keys(job.outputs).length && (
              <details className="shrink-0 text-xs">
                <summary className="cursor-pointer text-muted-foreground">{a.outputs}</summary>
                <dl className="mt-2 max-h-32 space-y-2 overflow-auto">
                  {Object.entries(job.outputs).map(([key, value]) => (
                    <div key={key}>
                      <dt className="font-mono text-muted-foreground">{key}</dt>
                      <dd className="break-all font-mono">{value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
          </section>
        ) : (
          <div className="flex min-h-64 items-center justify-center rounded-2xl bg-card p-5 text-sm text-muted-foreground">
            {a.selectJob}
          </div>
        )}
      </div>
    </section>
  );
}
