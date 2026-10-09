"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import type { ActionRunView } from "@repo/contracts";
import { actionsApi } from "@/lib/api/actions";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs } from "@/components/ui/Tabs";
import { useI18n } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { ActionError, ActionStatus } from "./ActionStatus";
import { ActionsEmptyState } from "./ActionsEmptyState";
import { ActionsSidebar } from "./ActionsSidebar";
import { useActionMutation, useActionResource, useActionScope } from "./useActions";

const load = async () => {
  const [workflows, runs, runners] = await Promise.all([
    actionsApi.list(),
    actionsApi.runs(),
    actionsApi.runners(),
  ]);
  return { workflows, runs, runners };
};

export function ActionRunList({ runs, empty }: { runs: ActionRunView[]; empty?: ReactNode }) {
  const { t, locale } = useI18n();
  if (!runs.length)
    return (
      empty ?? (
        <ActionsEmptyState
          compact
          kind="history"
          title={t.actions.noRuns}
          description={t.actions.noRunsHint}
        />
      )
    );
  return (
    <div className="divide-y divide-border/40 overflow-hidden rounded-2xl bg-card">
      {runs.map((run) => (
        <Link
          key={run.id}
          href={`/actions/runs/${run.id}`}
          className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4 transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Icon name="git-branch" className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {run.name}{" "}
              <span className="text-muted-foreground">
                #{run.number}
                {run.attempt > 1 ? ` · ${run.attempt}` : ""}
              </span>
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              <bdi>
                {run.owner}/{run.repo} · {run.ref.replace(/^refs\/(heads|tags)\//, "")} ·{" "}
                {run.revision.slice(0, 7)}
              </bdi>
            </p>
          </div>
          <ActionStatus status={run.status} />
          <time dateTime={run.createdAt} className="text-xs text-muted-foreground">
            {new Date(run.createdAt).toLocaleString(locale, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
          <Icon name="chevron-right" className="size-4 text-muted-foreground rtl:rotate-180" />
        </Link>
      ))}
    </div>
  );
}

function Home() {
  const { t } = useI18n();
  const a = t.actions;
  const { selfHosted } = usePlatform();
  const [tab, setTab] = useState<"workflows" | "runs" | "runners">("workflows");
  const [search, setSearch] = useState("");
  const resource = useActionResource(load, 8000);
  const mutation = useActionMutation();
  const data = resource.data;
  const readyRunnerCount =
    data?.runners.filter((runner) => runner.enabled && !runner.error).length ?? 0;
  const firstWorkflow = data?.workflows[0];
  const filteredWorkflows =
    data?.workflows.filter((workflow) =>
      `${workflow.name} ${workflow.owner}/${workflow.repo}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
    ) ?? [];
  const setupAction =
    readyRunnerCount > 0 ? (
      <Button asChild>
        <Link href="/actions/new">
          <Icon name="plus" />
          {a.newWorkflow}
        </Link>
      </Button>
    ) : data?.runners.length ? (
      <Button onClick={() => setTab("runners")}>
        {a.setup.reviewRunners}
        <Icon name="arrow-right" className="rtl:rotate-180" />
      </Button>
    ) : (
      <Button asChild>
        <Link href={selfHosted ? "/actions/runners/new" : "/actions/billing"}>
          <Icon name={selfHosted ? "plus" : "cloud"} />
          {selfHosted ? a.newRunner : a.setup.prepareCloud}
        </Link>
      </Button>
    );
  return (
    <PageContainer className="@container/actions-home space-y-6">
      <header className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <h1 className="text-2xl font-medium tracking-tight text-foreground">{a.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{a.subtitle}</p>
        </div>
        {!!(tab === "runners" ? data?.runners.length : data?.workflows.length) && (
          <Button asChild>
            <Link href={tab === "runners" ? "/actions/runners/new" : "/actions/new"}>
              <Icon name="plus" />
              {tab === "runners" ? a.newRunner : a.newWorkflow}
            </Link>
          </Button>
        )}
      </header>
      <Tabs
        tabs={[
          { key: "workflows", label: a.workflows, count: data?.workflows.length },
          { key: "runs", label: a.runs },
          { key: "runners", label: a.runners, count: data?.runners.length },
        ]}
        value={tab}
        onChange={setTab}
        idPrefix="actions"
      />
      <ActionError message={resource.error || mutation.error} onRetry={resource.refresh} />
      {resource.loading && !data ? (
        <div
          className="grid gap-6 @min-[980px]/actions-home:grid-cols-[minmax(0,1fr)_340px]"
          aria-busy="true"
          aria-label={a.title}
        >
          <div className="h-96 animate-pulse rounded-2xl bg-card" />
          <div className="h-72 animate-pulse rounded-2xl bg-card" />
        </div>
      ) : data ? (
        <div className="grid items-start gap-6 @min-[980px]/actions-home:grid-cols-[minmax(0,1fr)_340px]">
          <section
            id={`actions-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`actions-tab-${tab}`}
            className="@container/actions-content min-w-0 space-y-4"
          >
            {tab === "workflows" &&
              (data?.workflows.length ? (
                <>
                  <div className="relative">
                    <Icon
                      name="search"
                      className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      aria-label={a.search}
                      placeholder={a.search}
                      variant="filled"
                      type="search"
                      className="h-10 bg-muted/60 ps-10 pe-4"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-4 @min-[660px]/actions-content:grid-cols-2">
                    {filteredWorkflows.map((workflow) => {
                      const last = data.runs.find((run) => run.workflowId === workflow.id);
                      return (
                        <Link
                          href={`/actions/workflows/${workflow.id}`}
                          key={workflow.id}
                          className="group rounded-2xl bg-card p-5 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <div className="flex items-center gap-3">
                            <span className="rounded-xl bg-muted/50 p-2.5 text-muted-foreground">
                              <Icon name="topology" className="size-5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <h2 className="truncate text-base font-medium text-foreground">
                                {workflow.name}
                              </h2>
                              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                <bdi>
                                  {workflow.owner}/{workflow.repo}
                                </bdi>
                              </p>
                            </div>
                            <Icon
                              name="chevron-right"
                              className="size-4 text-muted-foreground rtl:rotate-180"
                            />
                          </div>
                          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                            <code className="truncate text-xs text-muted-foreground">
                              {workflow.path.split("/").pop()}
                            </code>
                            {!workflow.enabled ? (
                              <span className="text-xs text-muted-foreground">{a.disabled}</span>
                            ) : last ? (
                              <ActionStatus status={last.status} />
                            ) : (
                              <span className="text-xs text-muted-foreground">{a.noRuns}</span>
                            )}
                          </div>
                          {workflow.lastError && (
                            <p className="mt-3 line-clamp-2 text-xs text-destructive">
                              {workflow.lastError}
                            </p>
                          )}
                        </Link>
                      );
                    })}
                  </div>
                  {!filteredWorkflows.length && (
                    <div className="rounded-2xl bg-card px-5 py-10 text-center">
                      <p className="text-sm text-muted-foreground">{a.setup.noMatches}</p>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="mt-4"
                        onClick={() => setSearch("")}
                      >
                        {a.setup.clearSearch}
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <ActionsEmptyState title={a.emptyTitle} description={a.emptyDescription}>
                  {setupAction}
                </ActionsEmptyState>
              ))}
            {tab === "runs" && (
              <ActionRunList
                runs={data.runs}
                empty={
                  <ActionsEmptyState kind="history" title={a.noRuns} description={a.noRunsHint}>
                    {firstWorkflow ? (
                      <Button asChild>
                        <Link href={`/actions/workflows/${firstWorkflow.id}`}>
                          {a.setup.openWorkflow}
                          <Icon name="arrow-right" className="rtl:rotate-180" />
                        </Link>
                      </Button>
                    ) : (
                      setupAction
                    )}
                  </ActionsEmptyState>
                }
              />
            )}
            {tab === "runners" &&
              (data?.runners.length ? (
                <div className="grid grid-cols-1 gap-4 @min-[660px]/actions-content:grid-cols-2">
                  {data.runners.map((runner) => (
                    <article key={runner.id} className="rounded-2xl bg-card p-5">
                      <div className="flex items-center gap-3">
                        <span className="rounded-xl bg-muted/50 p-2.5 text-muted-foreground">
                          <Icon
                            name={runner.kind === "cloud" ? "cloud" : "server"}
                            className="size-5"
                          />
                        </span>
                        <div className="min-w-0 flex-1">
                          <h2 className="truncate text-base font-medium text-foreground">
                            {runner.name}
                          </h2>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {runner.kind === "cloud" ? a.cloudRunner : a.connectedRunner}
                          </p>
                        </div>
                        <span
                          className={`size-2 rounded-full ${runner.enabled && !runner.error ? "bg-success" : "bg-muted-foreground/40"}`}
                          aria-label={runner.enabled ? a.enabled : a.disabled}
                        />
                      </div>
                      <div className="mt-4 flex flex-wrap gap-1.5">
                        {runner.labels.map((label) => (
                          <code
                            key={label}
                            className="rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground"
                          >
                            {label}
                          </code>
                        ))}
                      </div>
                      <ActionError message={runner.error} />
                      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                        {runner.kind === "server" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={mutation.busy}
                            onClick={async () => {
                              if (await mutation.execute(() => actionsApi.probeRunner(runner.id)))
                                resource.refresh();
                            }}
                          >
                            {a.probe}
                          </Button>
                        )}
                        {runner.kind === "server" && (
                          <Button size="sm" variant="secondary" asChild>
                            <Link href={`/actions/runners/${runner.id}`}>{a.settings}</Link>
                          </Button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <ActionsEmptyState kind="runner" title={a.noRunners} description={a.noRunnersHint}>
                  {!selfHosted && (
                    <Button asChild>
                      <Link href="/actions/billing">
                        <Icon name="cloud" />
                        {a.setup.prepareCloud}
                      </Link>
                    </Button>
                  )}
                  <Button asChild variant={selfHosted ? "default" : "secondary"}>
                    <Link href="/actions/runners/new">
                      <Icon name="plus" />
                      {a.newRunner}
                    </Link>
                  </Button>
                </ActionsEmptyState>
              ))}
          </section>
          <ActionsSidebar
            runnerCount={data.runners.length}
            readyRunnerCount={readyRunnerCount}
            workflowCount={data.workflows.length}
            firstWorkflow={firstWorkflow}
            latestRun={data.runs[0]}
            onRunners={() => setTab("runners")}
          />
        </div>
      ) : null}
    </PageContainer>
  );
}
export function ActionsHome() {
  const scope = useActionScope();
  return <Home key={scope} />;
}
