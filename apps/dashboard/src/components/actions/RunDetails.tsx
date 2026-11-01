"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import { actionFinished } from "@repo/core";
import type { ActionRunView } from "@repo/contracts";
import { actionsApi } from "@/lib/api/actions";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { ActionError, ActionStatus } from "./ActionStatus";
import { RunWorkspace, type RunWorkspaceView } from "./RunWorkspace";
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
  const [view, setView] = useState<RunWorkspaceView>(
    query.get("view") === "graph"
      ? "graph"
      : query.get("view") === "approvals"
        ? "approvals"
        : "list",
  );
  const [selectedStep, setSelectedStep] = useState<string | null>(query.get("step"));
  const [rerunKey] = useState(() => crypto.randomUUID());
  const run = resource.data;
  const job =
    run?.jobs.find((job) => job.id === selected) ??
    run?.jobs.find((job) => job.status === "failure") ??
    run?.jobs.find((job) => job.status === "running") ??
    run?.jobs[0];
  useEffect(() => {
    if (!selected && job) setSelected(job.id);
  }, [selected, job?.id]);
  const select = (id: string, step?: string | null) => {
    setSelected(id);
    setSelectedStep(step ?? null);
    const url = new URL(window.location.href);
    url.searchParams.set("job", id);
    if (step) url.searchParams.set("step", step);
    else url.searchParams.delete("step");
    window.history.replaceState(null, "", url);
  };
  const changeView = (view: RunWorkspaceView) => {
    setView(view);
    const url = new URL(window.location.href);
    if (view !== "list") url.searchParams.set("view", view);
    else url.searchParams.delete("view");
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
            <div className="flex flex-wrap gap-2">
              {run.externalUrl && (
                <Button asChild variant="secondary">
                  <a href={run.externalUrl} target="_blank" rel="noopener noreferrer">
                    <Icon name="github" />
                    {a.controller.openGitHub}
                  </a>
                </Button>
              )}
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
          <RunWorkspace
            run={run}
            job={job}
            selectedStep={selectedStep}
            view={view}
            onSelect={select}
            onViewChange={changeView}
            approving={mutation.busy}
            onApprove={async () => {
              await mutation.execute(() => actionsApi.approve(id, run.admission?.key));
              resource.refresh();
            }}
          />
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
  return (
    <Suspense
      fallback={
        <PageContainer>
          <div className="h-72 animate-pulse rounded-2xl bg-card" />
        </PageContainer>
      }
    >
      <Detail key={`${scope}:${id}`} id={id} />
    </Suspense>
  );
}
