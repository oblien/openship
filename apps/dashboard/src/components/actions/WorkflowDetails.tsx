"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import type { ActionWorkflowView } from "@repo/contracts";
import { actionsApi } from "@/lib/api/actions";
import { PageContainer } from "@/components/ui/PageContainer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { CustomSelect } from "@/components/ui/CustomSelect";
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
    Object.fromEntries(workflow.plan.inputs.map((input) => [input.name, input.default])),
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
      {workflow.plan.inputs.map((input) => (
        <ActionField key={input.name} label={input.name} hint={input.description}>
          {input.type === "boolean" ? (
            <Checkbox
              aria-label={input.name}
              checked={inputs[input.name] === "true"}
              onCheckedChange={(value) => {
                setInputs((previous) => ({ ...previous, [input.name]: String(value) }));
                setKey(crypto.randomUUID());
              }}
            />
          ) : input.options.length ? (
            <CustomSelect
              aria-label={input.name}
              variant="filled"
              triggerClassName="bg-muted/60 hover:bg-muted"
              value={inputs[input.name] ?? ""}
              onChange={(value) => {
                setInputs((previous) => ({ ...previous, [input.name]: value }));
                setKey(crypto.randomUUID());
              }}
              options={input.options.map((value) => ({ value, label: value }))}
            />
          ) : (
            <Input
              variant="filled"
              value={inputs[input.name] ?? ""}
              required={input.required}
              type={input.type === "number" ? "number" : "text"}
              onChange={(event) => {
                setInputs((previous) => ({ ...previous, [input.name]: event.target.value }));
                setKey(crypto.randomUUID());
              }}
            />
          )}
        </ActionField>
      ))}
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
              <h1 className="text-2xl font-semibold tracking-tight">{data.workflow.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                <bdi>
                  {data.workflow.owner}/{data.workflow.repo} · {data.workflow.path}
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
          <div className="grid items-start gap-5 @min-[960px]:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-5">
              <WorkflowGraph plan={data.workflow.plan} />
              <div>
                <h2 className="mb-3 text-sm font-semibold">{a.runs}</h2>
                <ActionRunList runs={data.runs} />
              </div>
            </div>
            <aside className="space-y-4">
              <Dispatch workflow={data.workflow} />
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
