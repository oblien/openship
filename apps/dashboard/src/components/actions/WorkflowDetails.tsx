"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import type { ActionWorkflowView } from "@repo/contracts";
import { actionsApi } from "@/lib/api/actions";
import { getApiBaseUrl } from "@/lib/api/client";
import { WorkflowInputs, workflowInputDefaults } from "./WorkflowInputs";
import { workflowEventConfig } from "./workflow-yaml";
import { PageContainer } from "@/components/ui/PageContainer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { ActionError } from "./ActionStatus";
import { ActionField } from "./ActionField";
import { WorkflowGraph } from "./WorkflowGraph";
import { ActionRunList } from "./ActionsHome";
import { useActionMutation, useActionResource, useActionScope } from "./useActions";

function Dispatch({ workflow }: { workflow: ActionWorkflowView }) {
  const { t } = useI18n();
  const a = t.actions;
  const router = useRouter();
  const mutation = useActionMutation();
  const [ref, setRef] = useState(workflow.ref);
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    workflowInputDefaults(workflow.plan.inputs),
  );
  const [key, setKey] = useState(() => crypto.randomUUID());
  return (
    <form
      className="space-y-4 rounded-2xl bg-card p-5"
      onSubmit={async (event) => {
        event.preventDefault();
        const run = await mutation.execute(() =>
          actionsApi.dispatch(workflow.id, { ref, inputs, idempotencyKey: key }),
        );
        if (run) router.push(`/actions/runs/${run.id}`);
      }}
    >
      <h2 className="text-sm font-semibold">{a.run}</h2>
      <ActionError message={mutation.error} />
      {workflow.owner && (
        <ActionField label={a.ref}>
          <Input
            variant="filled"
            value={ref}
            required
            onChange={(event) => {
              setRef(event.target.value);
              setKey(crypto.randomUUID());
            }}
          />
        </ActionField>
      )}
      <WorkflowInputs
        definitions={workflow.plan.inputs}
        values={inputs}
        onChange={(value) => {
          setInputs(value);
          setKey(crypto.randomUUID());
        }}
      />
      <Button
        type="submit"
        className="w-full"
        disabled={
          mutation.busy ||
          !workflow.enabled ||
          !workflow.plan.triggers.includes("workflow_dispatch")
        }
      >
        <Icon name="play" />
        {a.run}
      </Button>
      {!workflow.plan.triggers.includes("workflow_dispatch") && (
        <p className="text-xs leading-relaxed text-muted-foreground">{a.manualHint}</p>
      )}
    </form>
  );
}

function Detail({ id }: { id: string }) {
  const { t } = useI18n();
  const a = t.actions;
  const fetcher = useCallback(
    async () => ({
      workflow: await actionsApi.get(id),
      runs: await actionsApi.runs(id),
      runners: await actionsApi.runners(),
      projects: await actionsApi.projects(),
    }),
    [id],
  );
  const resource = useActionResource(fetcher, 8000);
  const data = resource.data;
  return (
    <PageContainer className="@container space-y-5">
      <ActionError message={resource.error} onRetry={resource.refresh} />
      {data ? (
        <>
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <Button asChild size="sm" variant="ghost" className="mb-2 -ms-3">
                <Link href="/actions">
                  <Icon name="arrow-left" className="rtl:rotate-180" />
                  {a.back}
                </Link>
              </Button>
              <h1 className="text-2xl font-medium tracking-tight text-foreground">
                {data.workflow.name}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                <bdi>
                  {data.workflow.owner
                    ? `${data.workflow.owner}/${data.workflow.repo}`
                    : a.integration.standalone}{" "}
                  · {data.workflow.path}
                </bdi>
              </p>
            </div>
            <Button asChild variant="secondary">
              <Link href={`/actions/workflows/${id}/edit`}>
                <Icon name="settings" />
                {a.settings}
              </Link>
            </Button>
          </header>
          <ActionError message={data.workflow.lastError} />
          <div className="grid items-start gap-6 @min-[960px]:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-5">
              <WorkflowGraph plan={data.workflow.plan} />
              <div>
                <h2 className="mb-3 text-sm font-semibold">{a.runs}</h2>
                <ActionRunList runs={data.runs} />
              </div>
            </div>
            <aside className="space-y-4">
              <Dispatch key={data.workflow.id} workflow={data.workflow} />
              {data.workflow.owner && (
                <section className="space-y-3 rounded-2xl bg-card p-5">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold">{a.editor.updates}</h2>
                    <span className="rounded-md bg-muted px-2 py-1 text-xs">
                      {data.workflow.source ? a.editor.review : a.editor.automatic}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {data.workflow.controller === "github"
                      ? a.controller.githubHint
                      : data.workflow.source
                        ? a.editor.reviewHint
                        : a.editor.automaticHint}
                  </p>
                  <Button asChild size="sm" variant="secondary">
                    <Link href={`/actions/workflows/${id}/edit`}>{a.editor.checkUpdates}</Link>
                  </Button>
                </section>
              )}
              <section className="space-y-3 rounded-2xl bg-card p-5">
                <h2 className="text-sm font-semibold">{a.integration.triggers}</h2>
                <div className="flex flex-wrap gap-2">
                  {data.workflow.plan.triggers.map((trigger) => (
                    <code key={trigger} className="rounded-md bg-muted px-2 py-1 text-xs">
                      {trigger}
                    </code>
                  ))}
                </div>
                {data.workflow.plan.triggers.includes("workflow_dispatch") && (
                  <Button asChild variant="secondary" className="w-full">
                    <Link href={`/jobs/new?workflowId=${encodeURIComponent(id)}`}>
                      <Icon name="calendar-clock" />
                      {a.integration.jobTrigger}
                    </Link>
                  </Button>
                )}
                {data.workflow.controller !== "github" &&
                  data.workflow.plan.triggers.includes("repository_dispatch") && (
                    <details className="text-sm">
                      <summary className="cursor-pointer py-1 font-medium">
                        {a.integration.webhookEndpoint}
                      </summary>
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                        {a.integration.tokenHint}
                      </p>
                      <pre
                        dir="ltr"
                        className="mt-3 overflow-x-auto rounded-xl bg-background p-3 text-xs"
                      >{`POST ${getApiBaseUrl().replace(/\/$/, "")}/actions/workflows/${id}/dispatch
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

${JSON.stringify({ eventType: (workflowEventConfig(data.workflow.plan.triggerRules?.repository_dispatch).types as string[] | undefined)?.[0] ?? "release", clientPayload: {}, idempotencyKey: "unique-event-id" }, null, 2)}`}</pre>
                    </details>
                  )}
              </section>
              {!!data.workflow.projectIds?.length && (
                <section className="space-y-3 rounded-2xl bg-card p-5">
                  <h2 className="text-sm font-semibold">{a.integration.projects}</h2>
                  {data.projects
                    .filter((project) => data.workflow.projectIds?.includes(project.id))
                    .map((project) => (
                      <Link
                        key={project.id}
                        href={`/projects/${project.id}/actions`}
                        className="flex items-center gap-2 text-sm font-medium hover:underline"
                      >
                        <Icon name="folder" className="size-4 text-muted-foreground" />
                        <span className="truncate">{project.name}</span>
                        <Icon name="arrow-right" className="ms-auto size-4 rtl:rotate-180" />
                      </Link>
                    ))}
                </section>
              )}
              <section className="rounded-2xl bg-card p-5">
                <h2 className="text-sm font-semibold">{a.destinations}</h2>
                <div className="mt-4 space-y-3">
                  {data.runners
                    .filter((runner) => data.workflow.runnerIds.includes(runner.id))
                    .map((runner) => (
                      <div className="flex items-center gap-3" key={runner.id}>
                        <Icon
                          name={runner.kind === "cloud" ? "cloud" : "server"}
                          className="size-4 text-muted-foreground"
                        />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{runner.name}</p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {runner.labels.join(" · ")}
                          </p>
                        </div>
                      </div>
                    ))}
                </div>
              </section>
            </aside>
          </div>
        </>
      ) : resource.loading ? (
        <div className="h-72 animate-pulse rounded-2xl bg-card" />
      ) : null}
    </PageContainer>
  );
}
export function WorkflowDetails({ id }: { id: string }) {
  const scope = useActionScope();
  return <Detail key={`${scope}:${id}`} id={id} />;
}
