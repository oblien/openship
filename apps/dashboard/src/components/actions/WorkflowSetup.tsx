"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import type { ActionWorkflowView, ActionRunnerView, ActionProjectView } from "@repo/contracts";
import { actionsApi } from "@/lib/api/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Tabs } from "@/components/ui/Tabs";
import { Modal } from "@/components/ui/Modal";
import { optionCardSurface } from "@/components/shared/OptionCard";
import { RepositoryPicker } from "@/components/github/RepositoryPicker";
import { RepositoryBranchSelect } from "@/components/github/RepositoryBranchSelect";
import { BackupDestinationSelect } from "@/components/backup/BackupDestinationSelect";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n } from "@/components/i18n-provider";
import { ActionError } from "./ActionStatus";
import { ActionField } from "./ActionField";
import { WorkflowGraph } from "./WorkflowGraph";
import { ActionsIllustration } from "./ActionsIllustration";
import { ActionValues, type ActionValue } from "./ActionValues";
import { WorkflowTriggers } from "./WorkflowTriggers";
import { useActionMutation, useActionResource, useActionScope } from "./useActions";

export interface WorkflowSetupProps {
  id?: string;
  initial?: { owner?: string; repo?: string; ref?: string; projectId?: string; path?: string };
  onSaved: (workflow: ActionWorkflowView) => void;
  onCancel: () => void;
}

/** Project and deployment entry points open the same full-width setup. */
export function WorkflowSetupDialog(props: WorkflowSetupProps) {
  const { t } = useI18n();
  const { dialog, onKeyDown } = useDialogFocus(props.onCancel);
  return (
    <Modal isOpen onClose={props.onCancel} showCloseButton={false} width="1240px" maxWidth="96vw">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t.actions.newWorkflow}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="p-5 outline-none"
      >
        <WorkflowSetup {...props} />
      </div>
    </Modal>
  );
}

const STARTER =
  "name: CI\non: [push, workflow_dispatch]\njobs:\n  check:\n    runs-on: [self-hosted, linux]\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo 'Ready to build'\n";
const STANDALONE =
  "name: Automation\non: workflow_dispatch\njobs:\n  run:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: echo 'Ready to run'\n";
const storageKinds = ["s3_compatible", "local"] as const,
  cloudStorageKinds = ["s3_compatible"] as const;

function SetupForm({
  workflow,
  runners,
  projects,
  refresh,
  initial,
  onSaved,
  onCancel,
}: WorkflowSetupProps & {
  workflow?: ActionWorkflowView;
  runners: ActionRunnerView[];
  projects: ActionProjectView[];
  refresh: () => void;
}) {
  const { t } = useI18n(),
    { selfHosted } = usePlatform();
  const a = t.actions,
    c = a.integration;
  const mutation = useActionMutation(),
    prefix = useId();
  const [step, setStep] = useState<"workflow" | "rules">("workflow");
  const [standalone, setStandalone] = useState(!!workflow && !workflow.owner);
  const [repository, setRepository] = useState(
    workflow?.owner
      ? `${workflow.owner}/${workflow.repo}`
      : initial?.owner && initial.repo
        ? `${initial.owner}/${initial.repo}`
        : "",
  );
  const [ref, setRef] = useState(workflow?.ref ?? initial?.ref ?? "main");
  const [path, setPath] = useState(workflow?.path ?? initial?.path ?? ".github/workflows/ci.yml");
  const [mode, setMode] = useState<"repository" | "inline">(
    workflow?.source ? "inline" : "repository",
  );
  const [source, setSource] = useState(workflow?.source ?? "");
  const [original, setOriginal] = useState<{
    source: string;
    sha: string;
    identity: string;
  } | null>(null);
  const [name, setName] = useState(workflow?.name ?? "");
  const [runnerIds, setRunnerIds] = useState(workflow?.runnerIds ?? []);
  const [projectIds, setProjectIds] = useState(
    workflow?.projectIds ?? (initial?.projectId ? [initial.projectId] : []),
  );
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true);
  const [allowForks, setAllowForks] = useState(workflow?.allowForks ?? false);
  const [storage, setStorage] = useState(workflow?.storageDestinationId ?? "");
  const [variables, setVariables] = useState<ActionValue[]>(
    Object.entries(workflow?.variables ?? {}).map(([name, value]) => ({ id: name, name, value })),
  );
  const [secrets, setSecrets] = useState<ActionValue[]>(
    (workflow?.secretNames ?? []).map((name) => ({ id: name, name, value: "", saved: true })),
  );
  const [picker, setPicker] = useState(false),
    [review, setReview] = useState(false),
    [yamlOpen, setYamlOpen] = useState(false);
  const [owner, repo] = repository.trim().split("/");
  const repositoryValid = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository.trim());
  const files = useActionResource(
    useCallback(
      () =>
        !standalone && mode === "repository" && repositoryValid
          ? actionsApi.discover(owner!, repo!, ref)
          : Promise.resolve([]),
      [standalone, mode, repositoryValid, owner, repo, ref],
    ),
  );
  useEffect(() => {
    if (files.data?.length && !files.data.some((file) => file.path === path))
      setPath(files.data[0]!.path);
  }, [files.data, path]);
  const identity = `${owner}/${repo}:${ref}:${path}`;
  const file = useActionResource(
    useCallback(
      () =>
        !standalone &&
        mode === "repository" &&
        repositoryValid &&
        files.data?.some((file) => file.path === path)
          ? actionsApi
              .repositorySource({ owner: owner!, repo: repo!, ref, path })
              .then((data) => ({ ...data, identity }))
          : Promise.resolve(null),
      [standalone, mode, repositoryValid, owner, repo, ref, path, identity, files.data],
    ),
  );
  useEffect(() => {
    if (file.data && file.data.identity !== original?.identity) {
      setSource(file.data.source);
      setOriginal(file.data);
      if (!name && file.data.plan?.name) setName(file.data.plan.name);
    }
  }, [file.data, original?.identity, name]);
  // One shared preview validates both imported YAML and edits to its trigger controls.
  const [debounced, setDebounced] = useState(source);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(source), 300);
    return () => clearTimeout(timer);
  }, [source]);
  const preview = useActionResource(
    useCallback(
      () => (debounced.trim() ? actionsApi.preview(debounced, path) : Promise.resolve(null)),
      [debounced, path],
    ),
  );
  const readySource =
    !!source.trim() &&
    source === debounced &&
    !!preview.data &&
    !preview.error &&
    (standalone || repositoryValid) &&
    (mode === "inline" || original?.identity === identity);
  const hasIsolated = runners.some(
    (r) => r.kind === "cloud" && r.enabled && runnerIds.includes(r.id),
  );
  const dirty =
    mode === "repository" && original?.identity === identity && original.source !== source;
  const canSave = readySource && !!name.trim() && !!runnerIds.length && !mutation.busy;
  const savedId = useRef(workflow?.id);
  const chooseStandalone = (value: boolean) => {
    setStandalone(value);
    setSource(value ? STANDALONE : STARTER);
    setMode("inline");
    setOriginal(null);
    if (!value && repositoryValid) setMode("repository");
    if (value) setPath(".openship/workflows/automation.yml");
  };
  const save = async (commit: boolean) => {
    if (!canSave) return;
    if (
      [variables, secrets].some(
        (rows) =>
          new Set(rows.map((row) => row.name)).size !== rows.length ||
          rows.some((row) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name)),
      )
    ) {
      mutation.setError(c.invalidValues);
      return;
    }
    const saved = await mutation.execute(async () => {
      if (commit && dirty && original) {
        const written = await actionsApi.updateRepositorySource({
          owner: owner!,
          repo: repo!,
          ref,
          path,
          sha: original.sha,
          source,
        });
        setOriginal({ source, sha: written.sha, identity });
      }
      const result = await actionsApi.save(
        {
          name: name.trim(),
          owner: standalone ? null : owner!,
          repo: standalone ? null : repo!,
          ref: standalone ? "main" : ref,
          path,
          source: standalone || mode === "inline" || (dirty && !commit) ? source : null,
          runnerIds,
          projectIds,
          enabled,
          allowForks: !standalone && hasIsolated && allowForks,
          storageDestinationId: storage || null,
          variables: Object.fromEntries(variables.map((v) => [v.name, v.value])),
          secrets: Object.fromEntries(secrets.filter((v) => v.value).map((v) => [v.name, v.value])),
          removeSecrets: (workflow?.secretNames ?? []).filter(
            (name) => !secrets.some((v) => v.name === name),
          ),
        },
        savedId.current,
      );
      savedId.current = result.id;
      return result;
    });
    if (saved) onSaved(saved);
  };
  return (
    <div className="@container space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            {workflow ? workflow.name : a.newWorkflow}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{c.setupHint}</p>
        </div>
        <Button variant="ghost" onClick={onCancel}>
          {a.cancel}
        </Button>
      </header>
      <ActionError message={mutation.error} />
      <div className="grid items-start gap-6 @min-[960px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          {step === "workflow" ? (
            <>
              <section className="space-y-4 rounded-2xl bg-card p-5">
                <Tabs
                  tabs={[
                    { key: "repository", label: a.repository, icon: "github" },
                    { key: "standalone", label: c.standalone, icon: "terminal" },
                  ]}
                  value={standalone ? "standalone" : "repository"}
                  onChange={(value) => chooseStandalone(value === "standalone")}
                  idPrefix={prefix}
                />
                <div
                  role="tabpanel"
                  id={`${prefix}-panel-${standalone ? "standalone" : "repository"}`}
                  aria-labelledby={`${prefix}-tab-${standalone ? "standalone" : "repository"}`}
                  className="space-y-4"
                >
                  {standalone ? (
                    <p className="text-sm text-muted-foreground">{c.standaloneHint}</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="min-w-0 flex-1">
                          <ActionField label={a.repository}>
                            <Input
                              variant="filled"
                              value={repository}
                              onChange={(e) => {
                                setRepository(e.target.value);
                                setOriginal(null);
                              }}
                              placeholder={a.repositoryHint}
                            />
                          </ActionField>
                        </div>
                        <Button variant="secondary" onClick={() => setPicker(true)}>
                          {c.chooseRepo}
                        </Button>
                      </div>
                      {repositoryValid && (
                        <div className="grid gap-4 @min-[620px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                          <ActionField label={a.ref}>
                            <RepositoryBranchSelect
                              owner={owner!}
                              repo={repo!}
                              value={ref}
                              onChange={setRef}
                            />
                          </ActionField>
                          <ActionField label={a.workflowFile}>
                            {mode === "repository" && files.data?.length ? (
                              <CustomSelect
                                variant="filled"
                                triggerClassName="bg-muted/60 hover:bg-muted"
                                value={path}
                                onChange={setPath}
                                options={files.data.map((file) => ({
                                  value: file.path,
                                  label: file.name,
                                  description: file.path,
                                }))}
                              />
                            ) : (
                              <Input
                                variant="filled"
                                value={path}
                                onChange={(e) => setPath(e.target.value)}
                              />
                            )}
                          </ActionField>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <label className="flex items-center gap-2 text-xs">
                          <Checkbox
                            checked={mode === "inline"}
                            onCheckedChange={(value) => {
                              setMode(value ? "inline" : "repository");
                              if (value && !source) setSource(STARTER);
                            }}
                          />
                          {c.useCopy}
                        </label>
                        {mode === "repository" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={files.refresh}
                            disabled={files.loading}
                          >
                            {files.loading ? c.loading : a.discover}
                          </Button>
                        )}
                      </div>
                      <ActionError
                        message={files.error ?? file.error}
                        onRetry={() => {
                          files.refresh();
                          file.refresh();
                        }}
                      />
                      {mode === "repository" &&
                        repositoryValid &&
                        files.data?.length === 0 &&
                        !files.loading &&
                        !files.error && (
                          <p className="text-xs text-muted-foreground">{c.noFiles}</p>
                        )}
                    </>
                  )}
                  {(mode === "inline" || source) && (
                    <details
                      open={yamlOpen || standalone}
                      onToggle={(e) => setYamlOpen(e.currentTarget.open)}
                      className="group"
                    >
                      <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-sm font-medium">
                        <Icon
                          name="chevron-right"
                          className="size-4 transition-transform group-open:rotate-90"
                        />
                        {a.source}
                      </summary>
                      <textarea
                        aria-label={a.source}
                        dir="ltr"
                        value={source}
                        onChange={(e) => setSource(e.target.value)}
                        spellCheck={false}
                        className="mt-3 min-h-64 w-full resize-y rounded-xl bg-background p-4 font-mono text-xs leading-6 focus-visible:outline-2 focus-visible:outline-ring"
                      />
                    </details>
                  )}
                </div>
              </section>
              <ActionError message={preview.error ?? file.data?.error} />
              {readySource && preview.data ? (
                <WorkflowGraph plan={preview.data} />
              ) : (
                <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl bg-card p-6 text-center">
                  <ActionsIllustration className="mb-4 h-32 w-56" />
                  <p className="text-sm text-muted-foreground">
                    {(source && source !== debounced) || (file.loading && repositoryValid)
                      ? c.loading
                      : c.previewHint}
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              <WorkflowTriggers source={source} onChange={setSource} standalone={standalone} />
              <section className="space-y-4 rounded-2xl bg-card p-5">
                <h2 className="text-sm font-semibold">{c.projects}</h2>
                <p className="text-xs text-muted-foreground">{c.projectsHint}</p>
                {projects.length ? (
                  <div className="grid gap-2 @min-[600px]:grid-cols-2">
                    {projects.map((project) => (
                      <label
                        key={project.id}
                        className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm ${optionCardSurface(projectIds.includes(project.id))}`}
                      >
                        <Checkbox
                          checked={projectIds.includes(project.id)}
                          onCheckedChange={(checked) =>
                            setProjectIds((ids) =>
                              checked
                                ? [...ids, project.id]
                                : ids.filter((id) => id !== project.id),
                            )
                          }
                        />
                        <span className="min-w-0 truncate">{project.name}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {initial?.owner ? c.linkOnCreate : c.noProjects}
                  </p>
                )}
              </section>
              <section className="rounded-2xl bg-card p-5">
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold">
                    <Icon name="chevron-right" className="size-4 group-open:rotate-90" />
                    {c.environment}
                  </summary>
                  <div className="mt-5 space-y-5">
                    <div>
                      <h3 className="mb-3 text-sm font-medium">{a.variables}</h3>
                      <ActionValues values={variables} onChange={setVariables} />
                    </div>
                    <div>
                      <h3 className="mb-1 text-sm font-medium">{a.secrets}</h3>
                      <p className="mb-3 text-xs text-muted-foreground">{a.secretsHint}</p>
                      <ActionValues secret values={secrets} onChange={setSecrets} />
                    </div>
                    <ActionField label={a.storage} hint={a.storageHint}>
                      <BackupDestinationSelect
                        label={a.storage}
                        value={storage}
                        onChange={setStorage}
                        kinds={selfHosted ? storageKinds : cloudStorageKinds}
                      />
                    </ActionField>
                  </div>
                </details>
              </section>
              <ActionError message={preview.error} />
            </>
          )}
        </div>
        <aside className="space-y-4 @min-[960px]:sticky @min-[960px]:top-5">
          <section className="space-y-5 rounded-2xl bg-card p-5">
            <ol className="flex items-center gap-3 text-sm" aria-label={a.newWorkflow}>
              {(["workflow", "rules"] as const).map((value, index) => (
                <li key={value} className="flex flex-1 items-center gap-2">
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium ${step === value ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}
                  >
                    {index + 1}
                  </span>
                  <span className={step === value ? "font-medium" : "text-muted-foreground"}>
                    {value === "workflow" ? c.workflowStep : c.rulesStep}
                  </span>
                </li>
              ))}
            </ol>
            <ActionField label={a.name}>
              <Input
                variant="filled"
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
                placeholder="CI"
              />
            </ActionField>
            {step === "workflow" ? (
              <>
                <p className="text-xs leading-relaxed text-muted-foreground">{c.previewHint}</p>
                <Button className="w-full" disabled={!readySource} onClick={() => setStep("rules")}>
                  {c.continue}
                  <Icon name="arrow-right" className="rtl:rotate-180" />
                </Button>
              </>
            ) : (
              <>
                <div>
                  <h2 className="text-sm font-semibold">{a.destinations}</h2>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {a.destinationsHint}
                  </p>
                </div>
                <div className="space-y-2">
                  {runners.map((runner) => (
                    <label
                      key={runner.id}
                      className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 ${optionCardSurface(runnerIds.includes(runner.id))}`}
                    >
                      <Checkbox
                        checked={runnerIds.includes(runner.id)}
                        disabled={!runner.enabled && !runnerIds.includes(runner.id)}
                        onCheckedChange={(checked) =>
                          setRunnerIds((ids) =>
                            checked ? [...ids, runner.id] : ids.filter((id) => id !== runner.id),
                          )
                        }
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{runner.name}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {runner.labels.join(" · ")}
                        </span>
                      </span>
                    </label>
                  ))}
                  <div className="flex items-center justify-between gap-2">
                    <Button variant="ghost" size="sm" asChild>
                      <Link href="/actions/runners/new" target="_blank" rel="noopener noreferrer">
                        <Icon name="plus" />
                        {a.newRunner}
                      </Link>
                    </Button>
                    <Button variant="ghost" size="icon" onClick={refresh} aria-label={a.refresh}>
                      <Icon name="refresh" />
                    </Button>
                  </div>
                  {!selfHosted && !runners.some((runner) => runner.kind === "cloud") && (
                    <Button asChild variant="secondary" className="w-full">
                      <Link href="/actions/billing" target="_blank" rel="noopener noreferrer">
                        {a.setup.prepareCloud}
                      </Link>
                    </Button>
                  )}
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={enabled} onCheckedChange={setEnabled} />
                  {a.enabled}
                </label>
                {!standalone && (
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={allowForks && hasIsolated}
                      disabled={!hasIsolated}
                      onCheckedChange={setAllowForks}
                    />
                    <span>
                      {a.forks}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {a.forksHint}
                      </span>
                    </span>
                  </label>
                )}
                <div className="grid grid-cols-[auto_1fr] gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setStep("workflow")}
                    aria-label={c.previous}
                  >
                    <Icon name="arrow-left" className="rtl:rotate-180" />
                  </Button>
                  <Button
                    disabled={!canSave}
                    onClick={() => (dirty ? setReview(true) : void save(false))}
                  >
                    {mutation.busy ? a.saving : a.save}
                  </Button>
                </div>
              </>
            )}
          </section>
        </aside>
      </div>
      {picker && (
        <RepositoryPicker
          onClose={() => setPicker(false)}
          onSelect={(owner, repository) => {
            setRepository(`${owner}/${repository.name}`);
            setRef(repository.default_branch || "main");
            setMode("repository");
            setOriginal(null);
            setSource("");
            setPicker(false);
          }}
        />
      )}
      {review && (
        <SourceReview
          source={source}
          previous={original?.source ?? ""}
          onClose={() => setReview(false)}
          busy={mutation.busy}
          error={mutation.error}
          onCommit={() => void save(true)}
          onCopy={() => void save(false)}
        />
      )}
    </div>
  );
}
function SourceReview({
  source,
  previous,
  onClose,
  onCommit,
  onCopy,
  busy,
  error,
}: {
  source: string;
  previous: string;
  onClose: () => void;
  onCommit: () => void;
  onCopy: () => void;
  busy: boolean;
  error: string | null;
}) {
  const { t } = useI18n();
  const c = t.actions.integration;
  const id = useId();
  const { dialog, onKeyDown } = useDialogFocus(() => {
    if (!busy) onClose();
  });
  return (
    <Modal
      isOpen
      onClose={onClose}
      showCloseButton={false}
      width="960px"
      maxWidth="95vw"
      closable={!busy}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="space-y-4 p-5 outline-none"
      >
        <h2 className="text-lg font-medium" id={id}>
          {c.reviewChanges}
        </h2>
        <p className="text-sm text-muted-foreground">{c.commitHint}</p>
        <ActionError message={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          {[
            [c.before, previous],
            [c.after, source],
          ].map(([label, value]) => (
            <div className="min-w-0" key={label}>
              <h3 className="mb-2 text-xs font-medium">{label}</h3>
              <pre
                dir="ltr"
                className="max-h-80 overflow-auto whitespace-pre rounded-xl bg-background p-3 text-xs leading-6"
              >
                {value}
              </pre>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t.actions.cancel}
          </Button>
          <Button variant="secondary" onClick={onCopy} disabled={busy}>
            {c.saveCopy}
          </Button>
          <Button onClick={onCommit} disabled={busy}>
            {c.commitSave}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
function SetupLoader(props: WorkflowSetupProps) {
  const resource = useActionResource(
    useCallback(async () => {
      const [workflow, runners, projects] = await Promise.all([
        props.id ? actionsApi.get(props.id) : Promise.resolve(undefined),
        actionsApi.runners(),
        actionsApi.projects(),
      ]);
      return { workflow, runners, projects };
    }, [props.id]),
  );
  return (
    <>
      <ActionError message={resource.error} onRetry={resource.refresh} />
      {resource.data ? (
        <SetupForm {...props} {...resource.data} refresh={resource.refresh} />
      ) : resource.loading ? (
        <div className="h-80 animate-pulse rounded-2xl bg-card" />
      ) : null}
    </>
  );
}
export function WorkflowSetup(props: WorkflowSetupProps) {
  const scope = useActionScope();
  return (
    <SetupLoader
      key={`${scope}:${props.id ?? "new"}:${props.initial?.projectId ?? ""}`}
      {...props}
    />
  );
}
