"use client";

import { useState } from "react";
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
import { useActionMutation, useActionResource, useActionScope } from "./useActions";

const load = async () => {
  const [workflows, runs, runners] = await Promise.all([
    actionsApi.list(),
    actionsApi.runs(),
    actionsApi.runners(),
  ]);
  return { workflows, runs, runners };
};

export function ActionRunList({ runs }: { runs: ActionRunView[] }) {
  const { t, locale } = useI18n();
  if (!runs.length)
    return (
      <div className="rounded-2xl bg-card px-5 py-10 text-center">
        <p className="text-sm font-medium">{t.actions.noRuns}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t.actions.noRunsHint}</p>
      </div>
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
            <p className="truncate text-sm font-medium">
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
  const { deployMode, selfHosted } = usePlatform();
  const [tab, setTab] = useState<"workflows" | "runs" | "runners">("workflows");
  const [search, setSearch] = useState("");
  const resource = useActionResource(load, 8000);
  const mutation = useActionMutation();
  const data = resource.data;
  return (
    <PageContainer className="@container space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{a.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{a.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!selfHosted && (
            <Button asChild variant="secondary">
              <Link href="/actions/billing">
                <Icon name="credit-card" />
                {a.budget.label}
              </Link>
            </Button>
          )}
          <Button asChild>
            <Link href={tab === "runners" ? "/actions/runners/new" : "/actions/new"}>
              <Icon name="plus" />
              {tab === "runners" ? a.newRunner : a.newWorkflow}
            </Link>
          </Button>
        </div>
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
        <div className="h-48 animate-pulse rounded-2xl bg-card" aria-busy="true" />
      ) : (
        <section
          id={`actions-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`actions-tab-${tab}`}
          className="space-y-4"
        >
          {tab === "workflows" &&
            (data?.workflows.length ? (
              <>
                <div className="relative max-w-sm">
                  <Icon
                    name="search"
                    className="absolute start-3 top-3.5 size-4 text-muted-foreground"
                  />
                  <Input
                    aria-label={a.search}
                    placeholder={a.search}
                    variant="filled"
                    className="bg-card ps-10"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 @min-[760px]:grid-cols-2">
                  {data.workflows
                    .filter((workflow) =>
                      `${workflow.name} ${workflow.owner}/${workflow.repo}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((workflow) => {
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
                              <h2 className="truncate text-base font-semibold">{workflow.name}</h2>
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
              </>
            ) : (
              <Empty
                title={a.emptyTitle}
                description={a.emptyDescription}
                action={a.newWorkflow}
                href="/actions/new"
              />
            ))}
          {tab === "runs" && <ActionRunList runs={data?.runs ?? []} />}
          {tab === "runners" &&
            (data?.runners.length ? (
              <div className="grid grid-cols-1 gap-4 @min-[760px]:grid-cols-2">
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
                        <h2 className="truncate text-base font-semibold">{runner.name}</h2>
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
              <Empty
                title={a.noRunners}
                description={a.noRunnersHint}
                action={a.newRunner}
                href="/actions/runners/new"
              />
            ))}
        </section>
      )}
      {deployMode === "desktop" && (
        <aside className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card px-4 py-3">
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">{a.onlineHint}</p>
          <Button asChild size="sm" variant="ghost">
            <Link href="/settings?tab=instance">
              {a.publish}
              <Icon name="arrow-up-right" />
            </Link>
          </Button>
        </aside>
      )}
    </PageContainer>
  );
}
function Empty({
  title,
  description,
  action,
  href,
}: {
  title: string;
  description: string;
  action: string;
  href: string;
}) {
  return (
    <div className="flex flex-col items-center rounded-2xl bg-card px-5 py-14 text-center">
      <div aria-hidden="true" className="mb-6 flex items-center gap-2 text-muted-foreground/60">
        <span className="rounded-xl bg-muted/50 p-3">
          <Icon name="git-branch" className="size-6" />
        </span>
        <span className="h-px w-8 bg-border" />
        <span className="rounded-xl bg-muted/50 p-3">
          <Icon name="terminal" className="size-6" />
        </span>
        <span className="h-px w-8 bg-border" />
        <span className="rounded-xl bg-success/10 p-3 text-success">
          <Icon name="check" className="size-6" />
        </span>
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
      <Button asChild className="mt-5">
        <Link href={href}>{action}</Link>
      </Button>
    </div>
  );
}
export function ActionsHome() {
  const scope = useActionScope();
  return <Home key={scope} />;
}
