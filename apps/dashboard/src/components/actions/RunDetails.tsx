"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import { actionFinished } from "@repo/core";
import type { ActionRunView } from "@repo/contracts";
import { actionsApi } from "@/lib/api/actions";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/Tabs";
import { useI18n } from "@/components/i18n-provider";
import { ActionError, ActionStatus } from "./ActionStatus";
import { WorkflowGraph } from "./WorkflowGraph";
import { ActionLogs } from "./ActionLogs";
import { RunArtifacts } from "./RunArtifacts";
import { useActionMutation, useActionResource, useActionScope } from "./useActions";

const pollingDelay = (run: ActionRunView) => (run.settledAt ? 0 : 2500);

function Detail({ id }: { id: string }) {
  const { t } = useI18n();
  const a = t.actions;
  const router = useRouter();
  const query = useSearchParams();
  const fetcher = useCallback(() => actionsApi.run(id), [id]);
  const resource = useActionResource(fetcher, pollingDelay);
  const mutation = useActionMutation();
  const [selected, setSelected] = useState<string | null>(query.get("job"));
  const [view, setView] = useState<"graph" | "list">("graph");
  const [rerunKey] = useState(() => crypto.randomUUID());
  const run = resource.data;
  const job =
    run?.jobs.find((job) => job.id === selected) ??
    run?.jobs.find((job) => job.status === "failure") ??
    run?.jobs.find((job) => job.status === "running") ??
    run?.jobs[0];
  const select = (id: string) => {
    setSelected(id);
    const url = new URL(window.location.href);
    url.searchParams.set("job", id);
    window.history.replaceState(null, "", url);
  };
  return (
    <PageContainer className="@container space-y-5">
      <ActionError message={resource.error || mutation.error} onRetry={resource.refresh} />
      {run ? (
        <>
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <Button asChild size="sm" variant="ghost" className="mb-2 -ms-3">
                <Link href={`/actions/workflows/${run.workflowId}`}>
                  <Icon name="arrow-left" className="rtl:rotate-180" />
                  {run.name}
                </Link>
              </Button>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-medium tracking-tight text-foreground">
                  {run.name}{" "}
                  <span className="font-normal text-muted-foreground">#{run.number}</span>
                </h1>
                <ActionStatus status={run.status} />
              </div>
              <p className="mt-2 truncate text-xs text-muted-foreground">
                <bdi>
                  {run.owner
                    ? `${run.owner}/${run.repo} · ${run.ref.replace(/^refs\/(heads|tags)\//, "")}`
                    : t.actions.integration.standalone}{" "}
                  · {run.revision.slice(0, 7)} · {run.actor}
                </bdi>
              </p>
            </div>
            <div className="flex gap-2">
              {actionFinished(run.status) ? (
                <Button
                  variant="secondary"
                  disabled={mutation.busy}
                  onClick={async () => {
                    const next = await mutation.execute(() => actionsApi.rerun(id, rerunKey));
                    if (next) router.push(`/actions/runs/${next.id}`);
                  }}
                >
                  <Icon name="refresh" />
                  {a.rerun}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  disabled={mutation.busy || !!run.cancelRequestedAt}
                  onClick={async () => {
                    if (await mutation.execute(() => actionsApi.cancel(id))) resource.refresh();
                  }}
                >
                  <Icon name="square" />
                  {a.cancelRun}
                </Button>
              )}
            </div>
          </header>
          <ActionError message={run.error} />
          {run.untrusted && !run.approvedAt && !actionFinished(run.status) && (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-warning/5 p-4">
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                {a.approvalHint}
              </p>
              <Button
                disabled={mutation.busy}
                onClick={async () => {
                  if (await mutation.execute(() => actionsApi.approve(id))) resource.refresh();
                }}
              >
                {a.approve}
              </Button>
            </div>
          )}
          {run.cancelRequestedAt && !actionFinished(run.status) && (
            <p className="text-sm text-muted-foreground" role="status">
              {a.cancellingHint}
            </p>
          )}
          {run.finishedAt && !run.settledAt && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Icon name="spinner" className="size-3.5 motion-safe:animate-spin" />
              {a.cleaning}
            </p>
          )}
          <Tabs
            tabs={[
              { key: "graph", label: a.graph, icon: "topology" },
              { key: "list", label: a.list, icon: "list" },
            ]}
            value={view}
            onChange={setView}
            idPrefix="workflow-view"
          />
          <div
            role="tabpanel"
            id={`workflow-view-panel-${view}`}
            aria-labelledby={`workflow-view-tab-${view}`}
          >
            {view === "graph" ? (
              <WorkflowGraph plan={run.plan} run={run} selected={job?.id} onSelect={select} />
            ) : (
              <div className="divide-y divide-border/40 overflow-hidden rounded-2xl bg-card">
                {run.jobs.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={`flex w-full items-center justify-between gap-3 px-5 py-4 text-start hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring ${row.id === job?.id ? "bg-muted/40" : ""}`}
                    onClick={() => select(row.id)}
                  >
                    <span className="text-sm font-medium">{row.name}</span>
                    <ActionStatus
                      status={
                        row.phase === "provisioning" && row.status === "running"
                          ? "provisioning"
                          : row.status
                      }
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
          {job ? (
            <section className="min-w-0 space-y-4 rounded-2xl bg-card p-5">
              <header className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{job.name}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{job.labels.join(" · ")}</p>
                </div>
                <ActionStatus
                  status={
                    job.phase === "provisioning" && job.status === "running"
                      ? "provisioning"
                      : job.status
                  }
                />
              </header>
              <ActionError message={job.status === "cancelled" ? null : job.error} />
              {job.checkError && (
                <p className="text-xs text-muted-foreground" title={job.checkError}>
                  {a.checkPending}
                </p>
              )}
              <ActionLogs key={job.id} job={job} />
            </section>
          ) : (
            <p className="py-5 text-center text-sm text-muted-foreground">{a.selectJob}</p>
          )}
          <RunArtifacts runId={run.id} settled={!!run.settledAt} />
        </>
      ) : resource.loading ? (
        <div className="h-72 animate-pulse rounded-2xl bg-card" />
      ) : null}
    </PageContainer>
  );
}
export function RunDetails({ id }: { id: string }) {
  const scope = useActionScope();
  return <Detail key={`${scope}:${id}`} id={id} />;
}
