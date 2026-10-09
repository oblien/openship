"use client";

import { useCallback, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import type { ActionPlanView, ActionRunnerView, ActionWorkflowView } from "@repo/contracts";
import { actionsApi } from "@/lib/api/actions";
import { PageContainer } from "@/components/ui/PageContainer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Tabs } from "@/components/ui/Tabs";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { optionCardSurface } from "@/components/shared/OptionCard";
import { BackupDestinationSelect } from "@/components/backup/BackupDestinationSelect";
import { useI18n } from "@/components/i18n-provider";
import { ActionError } from "./ActionStatus";
import { WorkflowGraph } from "./WorkflowGraph";
import { useActionMutation, useActionResource, useActionScope } from "./useActions";
import { ActionField } from "./ActionField";
import { usePlatform } from "@/context/PlatformContext";

const storageKinds = ["s3_compatible", "local"] as const;
const cloudStorageKinds = ["s3_compatible"] as const;
type Pair = { id: string; name: string; value: string; saved?: boolean };
function Values({
  secret,
  values,
  onChange,
}: {
  secret?: boolean;
  values: Pair[];
  onChange: (values: Pair[]) => void;
}) {
  const { t } = useI18n();
  const a = t.actions;
  const prefix = useId();
  return (
    <div className="space-y-3">
      {values.map((pair, index) => (
        <div className="flex items-center gap-2" key={pair.id}>
          <Input
            id={`${prefix}-${index}-name`}
            aria-label={`${secret ? a.secrets : a.variables}: ${a.key} ${index + 1}`}
            value={pair.name}
            placeholder="MY_VARIABLE"
            variant="filled"
            className="min-w-0 flex-1 font-mono"
            pattern="[A-Za-z_][A-Za-z0-9_]*"
            required
            disabled={pair.saved}
            onChange={(event) =>
              onChange(
                values.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)),
              )
            }
          />
          <Input
            aria-label={`${a.value}: ${pair.name || index + 1}`}
            value={pair.value}
            placeholder={pair.saved ? "••••••••" : a.value}
            autoComplete="off"
            type={secret ? "password" : "text"}
            variant="filled"
            className="min-w-0 flex-1"
            onChange={(event) =>
              onChange(
                values.map((row, i) => (i === index ? { ...row, value: event.target.value } : row)),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${a.remove}: ${pair.name || index + 1}`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            <Icon name="close" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => onChange([...values, { id: crypto.randomUUID(), name: "", value: "" }])}
      >
        <Icon name="plus" />
        {a.addValue}
      </Button>
    </div>
  );
}

function Form({
  workflow,
  runners,
}: {
  workflow?: ActionWorkflowView;
  runners: ActionRunnerView[];
}) {
  const { t } = useI18n();
  const a = t.actions;
  const router = useRouter();
  const mutation = useActionMutation();
  const [name, setName] = useState(workflow?.name ?? "");
  const [repository, setRepository] = useState(
    workflow ? `${workflow.owner}/${workflow.repo}` : "",
  );
  const [ref, setRef] = useState(workflow?.ref ?? "main");
  const [path, setPath] = useState(workflow?.path ?? ".github/workflows/ci.yml");
  const [source, setSource] = useState(
    workflow?.source ??
      "name: CI\non: [push, workflow_dispatch]\njobs:\n  check:\n    runs-on: [self-hosted, linux]\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo 'Ready to build'\n",
  );
  const [mode, setMode] = useState<"repository" | "inline">(
    workflow?.source ? "inline" : "repository",
  );
  const [runnerIds, setRunnerIds] = useState(workflow?.runnerIds ?? []);
  const [allowForks, setAllowForks] = useState(workflow?.allowForks ?? false);
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true);
  const [storageDestinationId, setStorageDestinationId] = useState(
    workflow?.storageDestinationId ?? "",
  );
  const [variables, setVariables] = useState<Pair[]>(
    Object.entries(workflow?.variables ?? {}).map(([name, value]) => ({ id: name, name, value })),
  );
  const [secrets, setSecrets] = useState<Pair[]>(
    (workflow?.secretNames ?? []).map((name) => ({ id: name, name, value: "", saved: true })),
  );
  const [preview, setPreview] = useState<ActionPlanView | null>(workflow?.plan ?? null);
  const [files, setFiles] = useState<Array<{ name: string; path: string }> | null>(null);
  const [owner, repo] = repository.trim().split("/");
  const hasIsolatedRunner = runners.some(
    (runner) => runner.kind === "cloud" && runner.enabled && runnerIds.includes(runner.id),
  );

  return (
    <form
      className="@container space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        const saved = await mutation.execute(() =>
          actionsApi.save(
            {
              name,
              owner,
              repo: repo ?? "",
              ref,
              path,
              source: mode === "inline" ? source : null,
              runnerIds,
              enabled,
              allowForks: allowForks && hasIsolatedRunner,
              storageDestinationId: storageDestinationId || null,
              variables: Object.fromEntries(variables.map((pair) => [pair.name, pair.value])),
              secrets: Object.fromEntries(
                secrets.filter((pair) => pair.value).map((pair) => [pair.name, pair.value]),
              ),
              removeSecrets: (workflow?.secretNames ?? []).filter(
                (name) => !secrets.some((pair) => pair.name === name),
              ),
            },
            workflow?.id,
          ),
        );
        if (saved) router.push(`/actions/workflows/${saved.id}`);
      }}
    >
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Button asChild size="sm" variant="ghost" className="mb-2 -ms-3">
            <Link href="/actions">
              <Icon name="arrow-left" className="rtl:rotate-180" />
              {a.back}
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">
            {workflow ? workflow.name : a.newWorkflow}
          </h1>
        </div>
        <Button asChild variant="ghost">
          <Link href={workflow ? `/actions/workflows/${workflow.id}` : "/actions"}>{a.cancel}</Link>
        </Button>
      </header>
      <ActionError message={mutation.error} />
      <div className="grid items-start gap-5 @min-[960px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <section className="space-y-5 rounded-2xl bg-card p-5">
            <div className="grid gap-4 @min-[700px]:grid-cols-2">
              <ActionField label={a.name}>
                <Input
                  variant="filled"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={100}
                />
              </ActionField>
              <ActionField label={a.repository}>
                <Input
                  variant="filled"
                  value={repository}
                  onChange={(event) => {
                    setRepository(event.target.value);
                    setFiles(null);
                    setPreview(null);
                  }}
                  placeholder={a.repositoryHint}
                  pattern="[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+"
                  required
                />
              </ActionField>
            </div>
            <Tabs
              tabs={[
                { key: "repository", label: a.fromRepository },
                { key: "inline", label: a.inline },
              ]}
              value={mode}
              onChange={(value) => {
                setMode(value);
                setPreview(null);
              }}
              idPrefix="workflow-source"
            />
            <div
              id={`workflow-source-panel-${mode}`}
              role="tabpanel"
              aria-labelledby={`workflow-source-tab-${mode}`}
              className="space-y-4"
            >
              <div className="grid gap-4 @min-[700px]:grid-cols-[180px_minmax(0,1fr)]">
                <ActionField label={a.ref}>
                  <Input
                    variant="filled"
                    value={ref}
                    onChange={(event) => {
                      setRef(event.target.value);
                      setFiles(null);
                    }}
                    required
                  />
                </ActionField>
                <ActionField label={a.workflowFile}>
                  {files?.length ? (
                    <CustomSelect
                      variant="filled"
                      triggerClassName="bg-muted/60 hover:bg-muted"
                      value={path}
                      onChange={setPath}
                      options={files.map((file) => ({
                        value: file.path,
                        label: file.name,
                        description: file.path,
                      }))}
                    />
                  ) : (
                    <Input
                      variant="filled"
                      value={path}
                      onChange={(event) => setPath(event.target.value)}
                      required
                    />
                  )}
                </ActionField>
              </div>
              {mode === "repository" ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">{a.sourceHint}</p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={mutation.busy || !owner || !repo}
                    onClick={async () => {
                      const result = await mutation.execute(() =>
                        actionsApi.discover(owner, repo, ref),
                      );
                      if (result) {
                        setFiles(result);
                        if (result[0]) setPath(result[0].path);
                      }
                    }}
                  >
                    {a.discover}
                  </Button>
                </div>
              ) : (
                <>
                  <ActionField label={a.source}>
                    <textarea
                      value={source}
                      onChange={(event) => {
                        setSource(event.target.value);
                        setPreview(null);
                      }}
                      className="min-h-72 w-full resize-y rounded-xl bg-background px-4 py-3 font-mono text-xs leading-6 focus-visible:outline-2 focus-visible:outline-ring"
                      spellCheck={false}
                      dir="ltr"
                      required
                    />
                  </ActionField>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={mutation.busy}
                    onClick={async () => {
                      const value = await mutation.execute(() => actionsApi.preview(source, path));
                      if (value) setPreview(value);
                    }}
                  >
                    {a.preview}
                  </Button>
                </>
              )}
            </div>
          </section>
          {preview && <WorkflowGraph plan={preview} />}
          <section className="space-y-4 rounded-2xl bg-card p-5">
            <h2 className="text-sm font-semibold">{a.variables}</h2>
            <Values values={variables} onChange={setVariables} />
          </section>
          <section className="space-y-4 rounded-2xl bg-card p-5">
            <div>
              <h2 className="text-sm font-semibold">{a.secrets}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{a.secretsHint}</p>
            </div>
            <Values secret values={secrets} onChange={setSecrets} />
          </section>
          <section className="space-y-4 rounded-2xl bg-card p-5">
            <ActionField label={a.storage} hint={a.storageHint}>
              <ActionStorageSelector
                value={storageDestinationId}
                onChange={setStorageDestinationId}
                label={a.storage}
              />
            </ActionField>
          </section>
        </div>
        <aside className="space-y-5 rounded-2xl bg-card p-5 @min-[960px]:sticky @min-[960px]:top-5">
          <div>
            <h2 className="text-sm font-semibold">{a.destinations}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {a.destinationsHint}
            </p>
          </div>
          <div className="space-y-2">
            {runners.map((runner) => (
              <button
                type="button"
                key={runner.id}
                role="checkbox"
                aria-checked={runnerIds.includes(runner.id)}
                disabled={!runner.enabled && !runnerIds.includes(runner.id)}
                className={`flex w-full items-center gap-3 rounded-xl border p-3 text-start transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 ${optionCardSurface(runnerIds.includes(runner.id))}`}
                onClick={() =>
                  setRunnerIds((ids) =>
                    ids.includes(runner.id)
                      ? ids.filter((id) => id !== runner.id)
                      : [...ids, runner.id],
                  )
                }
              >
                <Checkbox asButton={false} checked={runnerIds.includes(runner.id)} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{runner.name}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {runner.labels.join(" · ")}
                  </span>
                </span>
              </button>
            ))}
            <Button type="button" asChild size="sm" variant="ghost">
              <Link href="/actions/runners/new">
                <Icon name="plus" />
                {a.newRunner}
              </Link>
            </Button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={enabled} onCheckedChange={setEnabled} />
            {a.enabled}
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={allowForks && hasIsolatedRunner}
              disabled={!hasIsolatedRunner}
              onCheckedChange={setAllowForks}
            />
            <span>
              {a.forks}
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                {a.forksHint}
              </span>
            </span>
          </label>
          <Button type="submit" className="w-full" disabled={mutation.busy || !runnerIds.length}>
            {mutation.busy ? a.saving : a.save}
          </Button>
        </aside>
      </div>
    </form>
  );
}

function ActionStorageSelector(props: {
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const { selfHosted } = usePlatform();
  return (
    <BackupDestinationSelect {...props} kinds={selfHosted ? storageKinds : cloudStorageKinds} />
  );
}

function Loader({ id }: { id?: string }) {
  const fetcher = useCallback(
    async () => ({
      workflow: id ? await actionsApi.get(id) : undefined,
      runners: await actionsApi.runners(),
    }),
    [id],
  );
  const resource = useActionResource(fetcher);
  return (
    <PageContainer>
      <ActionError message={resource.error} onRetry={resource.refresh} />
      {resource.data ? (
        <Form workflow={resource.data.workflow} runners={resource.data.runners} />
      ) : resource.loading ? (
        <div className="h-72 animate-pulse rounded-2xl bg-card" />
      ) : null}
    </PageContainer>
  );
}
export function WorkflowEditor({ id }: { id?: string }) {
  const scope = useActionScope();
  return <Loader key={`${scope}:${id ?? "new"}`} id={id} />;
}
