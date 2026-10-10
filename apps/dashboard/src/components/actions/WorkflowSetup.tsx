"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import type {
  ActionWorkflowView,
  ActionRunnerView,
  ActionProjectView,
  ActionPlanView,
} from "@repo/contracts";
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
import type { TopologySelection } from "@/components/topology/TopologyCanvas";
import { WorkflowWorkspace, type WorkflowWorkspaceView } from "./WorkflowWorkspace";
import { WorkflowJobInspector } from "./WorkflowJobInspector";
import type { WorkflowExpandedSteps, WorkflowStepTarget } from "./WorkflowSteps";
import {
  WorkflowEditError,
  addWorkflowJob,
  editWorkflowDependency,
  workflowJobs,
} from "./workflow-editor";
import { useWorkflowDraft } from "./useWorkflowDraft";
import { ActionValues, type ActionValue } from "./ActionValues";
import { WorkflowTriggers } from "./WorkflowTriggers";
import { useActionMutation, useActionResource, useActionScope } from "./useActions";

export interface WorkflowSetupProps {
  id?: string;
  fullHeight?: boolean;
  onBusyChange?: (busy: boolean) => void;
  initial?: { owner?: string; repo?: string; ref?: string; projectId?: string; path?: string };
  onSaved: (workflow: ActionWorkflowView) => void;
  onCancel: () => void;
}

/** Project and deployment entry points open the same full-width setup. */
export function WorkflowSetupDialog(props: WorkflowSetupProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (!busy) props.onCancel();
  };
  const { dialog, onKeyDown } = useDialogFocus(close);
  return (
    <Modal
      isOpen
      onClose={close}
      closable={!busy}
      showCloseButton={false}
      surface="frosted"
      width="calc(100vw - 32px)"
      maxWidth="calc(100vw - 32px)"
      height="calc(100dvh - 32px)"
      maxHeight="calc(100dvh - 32px)"
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t.actions.newWorkflow}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="h-full min-h-0 p-3 outline-none sm:p-5"
      >
        <WorkflowSetup {...props} onCancel={close} onBusyChange={setBusy} fullHeight />
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
  fullHeight,
  onBusyChange,
}: WorkflowSetupProps & {
  workflow?: ActionWorkflowView;
  runners: ActionRunnerView[];
  projects: ActionProjectView[];
  refresh: () => void;
}) {
  const { t } = useI18n(),
    { selfHosted } = usePlatform();
  const a = t.actions,
    c = a.integration,
    e = a.editor;
  const mutation = useActionMutation(),
    prefix = useId();
  useEffect(() => {
    onBusyChange?.(mutation.busy);
  }, [mutation.busy, onBusyChange]);
  const [controller, setController] = useState<"github" | "openship">(
    workflow?.controller ?? "github",
  );
  const [trusted, setTrusted] = useState(workflow?.controller === "github");
  const [step, setStep] = useState<"workflow" | "rules">("workflow");
  const [standalone, setStandalone] = useState(!!workflow && !workflow.owner);
  const native = !standalone && controller === "github";
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
  const draft = useWorkflowDraft(workflow?.source ?? "");
  const { source, change: setSource } = draft;
  const [selection, setSelection] = useState<TopologySelection>(null);
  const [view, setView] = useState<WorkflowWorkspaceView>("topology");
  const [expandedSteps, setExpandedSteps] = useState<WorkflowExpandedSteps>({});
  const [stepToReveal, setStepToReveal] = useState<WorkflowStepTarget | null>(null);
  const [yamlRequest, setYamlRequest] = useState<{ id: string; key: number } | null>(null);
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
    [review, setReview] = useState<SourceReviewSnapshot | null>(null);
  const [owner, repo] = repository.trim().split("/");
  const repositoryValid = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository.trim());
  const files = useActionResource(
    useCallback(
      () =>
        !standalone && repositoryValid
          ? actionsApi
              .discover(owner!, repo!, ref)
              .then((files) =>
                native ? files.filter((file) => file.path.startsWith(".github/workflows/")) : files,
              )
          : Promise.resolve([]),
      [standalone, repositoryValid, owner, repo, ref, native],
    ),
  );
  useEffect(() => {
    if (
      !workflow &&
      !initial?.path &&
      mode === "repository" &&
      files.data?.length &&
      !files.data.some((file) => file.path === path)
    )
      setPath(files.data[0]!.path);
  }, [files.data, path, mode, workflow, initial?.path]);
  const identity = `${owner}/${repo}:${ref}:${path}`;
  const file = useActionResource(
    useCallback(
      () =>
        !standalone &&
        repositoryValid &&
        (files.data?.some((file) => file.path === path) || (!!workflow && !!files.data))
          ? actionsApi
              .repositorySource({
                owner: owner!,
                repo: repo!,
                ref,
                path,
                controller: native ? "github" : "openship",
              })
              .then((data) => ({ ...data, identity }))
          : Promise.resolve(null),
      [standalone, repositoryValid, owner, repo, ref, path, identity, files.data, workflow, native],
    ),
  );
  const loaded = useRef<{ identity: string; source: string; file: unknown } | null>(null);
  useEffect(() => {
    const value = file.data;
    if (!value || value.identity !== identity || loaded.current?.file === value) return;
    const previous = loaded.current;
    const first = previous?.identity !== identity;
    const savedIdentity = workflow?.owner
      ? `${workflow.owner}/${workflow.repo}:${workflow.ref}:${workflow.path}`
      : null;
    const keepSaved = !previous && !!workflow?.source && identity === savedIdentity;
    const untouched = previous?.source === source && mode === "repository" && !review;
    if ((first && !keepSaved) || (!first && untouched)) draft.reset(value.source);
    loaded.current = { identity, source: value.source, file: value };
    setOriginal(value);
    if (!name && value.plan?.name) setName(value.plan.name);
  }, [file.data, identity, workflow, source, mode, review, draft.reset, name]);
  // One shared preview validates both imported YAML and edits to its trigger controls.
  const [debounced, setDebounced] = useState(source);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(source), 300);
    return () => clearTimeout(timer);
  }, [source]);
  const preview = useActionResource(
    useCallback(
      () =>
        debounced.trim()
          ? actionsApi.preview(debounced, path, native ? "github" : "openship")
          : Promise.resolve(null),
      [debounced, path, native],
    ),
  );
  const [lastPlan, setLastPlan] = useState<{ identity: string; plan: ActionPlanView } | null>(null);
  useEffect(() => {
    if (preview.data && source === debounced) setLastPlan({ identity, plan: preview.data });
  }, [preview.data, source, debounced, identity]);
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
  const differsFromRepository = original?.identity === identity && original.source !== source;
  const dirty = !standalone && differsFromRepository;
  const canSave =
    readySource && !!name.trim() && !!runnerIds.length && (!native || trusted) && !mutation.busy;
  const savedId = useRef(workflow?.id);
  const chooseStandalone = (value: boolean) => {
    setStandalone(value);
    draft.reset(value ? STANDALONE : STARTER);
    loaded.current = null;
    setSelection(null);
    setMode("inline");
    setOriginal(null);
    if (!value && repositoryValid) setMode("repository");
    if (value) setPath(".openship/workflows/automation.yml");
  };
  const save = async (commit: boolean, snapshot?: SourceReviewSnapshot) => {
    if (!canSave || (snapshot && (snapshot.source !== source || snapshot.identity !== identity)))
      return;
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
          sha: snapshot?.sha ?? original.sha,
          source,
          controller: native ? "github" : "openship",
        });
        setOriginal({ source, sha: written.sha, identity });
      }
      const result = await actionsApi.save(
        {
          name: name.trim(),
          controller: native ? "github" : "openship",
          ...(native && { repositoryRunnerConsent: trusted }),
          owner: standalone ? null : owner!,
          repo: standalone ? null : repo!,
          ref: standalone ? "main" : ref,
          path,
          source: native
            ? null
            : standalone || mode === "inline" || (dirty && !commit)
              ? source
              : null,
          runnerIds,
          projectIds,
          enabled,
          allowForks: !native && !standalone && hasIsolated && allowForks,
          storageDestinationId: native ? null : storage || null,
          variables: native ? {} : Object.fromEntries(variables.map((v) => [v.name, v.value])),
          secrets: native
            ? {}
            : Object.fromEntries(secrets.filter((v) => v.value).map((v) => [v.name, v.value])),
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
  const edit = (operation: () => string) => {
    try {
      setSource(operation());
      mutation.setError(null);
    } catch (error) {
      // diagnostics-ignore: YAML edits are local validation; never report draft commands or secrets.
      mutation.setError(error instanceof WorkflowEditError ? e.errors[error.code] : c.fixYaml);
    }
  };
  useEffect(() => {
    if (!selection) return;
    try {
      const jobs = workflowJobs(source);
      if (selection.kind === "node" && !jobs.some((job) => job.id === selection.id))
        setSelection(null);
      if (selection.kind === "edge") {
        const [from, to] = selection.id.split(":");
        const value = jobs.find((job) => job.id === to)?.value.needs;
        if (!(Array.isArray(value) ? value.includes(from) : value === from)) setSelection(null);
      }
    } catch {
      // diagnostics-ignore: Keep the selected inspector while its YAML draft is incomplete.
    }
  }, [source, selection]);
  const selectWorkflowItem = (selection: TopologySelection) => {
    setSelection(selection);
    setStepToReveal(null);
  };
  const changeExpandedSteps = (expanded: WorkflowExpandedSteps) => {
    setExpandedSteps(expanded);
    // An inline reorder/removal must not leave a different step highlighted on the canvas.
    setStepToReveal(null);
  };
  const editJobYaml = (id: string) => {
    selectWorkflowItem({ kind: "node", id });
    setYamlRequest((previous) => ({ id, key: (previous?.key ?? 0) + 1 }));
  };
  const selectStepNode = (jobId: string, index: number) => {
    setSelection({ kind: "node", id: jobId });
    setExpandedSteps((current) => {
      const steps = current[jobId] ?? [];
      return steps.includes(index) ? current : { ...current, [jobId]: [...steps, index] };
    });
    setStepToReveal((current) => ({ jobId, index, request: (current?.request ?? 0) + 1 }));
  };
  const reviewSource = (kind: "save" | "incoming") => {
    if (!original || original.identity !== identity) return;
    setReview({ kind, source, previous: original.source, sha: original.sha, identity });
  };
  const plan =
    !standalone && mode === "repository" && original?.identity !== identity
      ? null
      : preview.data && source === debounced
        ? preview.data
        : lastPlan?.identity === identity
          ? lastPlan.plan
          : null;
  return (
    <div className={`@container ${fullHeight ? "h-full" : ""}`}>
      <div
        className={`flex flex-col gap-4 @min-[960px]:min-h-0 ${fullHeight ? "@min-[960px]:h-full" : "@min-[960px]:h-[calc(100dvh-164px)] @min-[960px]:min-h-[560px]"}`}
      >
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center text-foreground/80">
              <Icon name="play-circle" className="size-7" />
            </span>
            <div className="min-w-0">
              <h1 className="text-2xl font-medium tracking-tight text-foreground">
                {workflow ? workflow.name : a.newWorkflow}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">{e.setupHint}</p>
            </div>
          </div>
          <Button variant="ghost" onClick={onCancel} disabled={mutation.busy}>
            {a.cancel}
          </Button>
        </header>
        <div
          className="grid gap-4 @min-[960px]:min-h-0 @min-[960px]:flex-1 @min-[960px]:grid-cols-[minmax(0,1fr)_400px] @min-[1200px]:grid-cols-[minmax(0,1fr)_420px]"
          inert={mutation.busy}
          aria-busy={mutation.busy}
        >
          <WorkflowWorkspace
            plan={plan}
            view={view}
            onViewChange={setView}
            edit={edit}
            expandedSteps={expandedSteps}
            onExpandedStepsChange={changeExpandedSteps}
            onSelectStepNode={selectStepNode}
            stepToReveal={stepToReveal}
            onEditYaml={editJobYaml}
            draft={draft}
            yamlRequest={yamlRequest}
            selection={selection}
            onSelect={selectWorkflowItem}
            onConnect={({ source: from, target: to }) =>
              edit(() => editWorkflowDependency(source, from, to, true))
            }
            onAdd={() =>
              edit(() => {
                const added = addWorkflowJob(source);
                selectWorkflowItem({ kind: "node", id: added.id });
                return added.source;
              })
            }
            loading={preview.loading || file.loading || source !== debounced}
            invalid={!!preview.error}
          />
          <aside
            className="flex min-h-0 flex-col rounded-2xl bg-popover/60 backdrop-blur-2xl [&_:is(input,textarea).bg-background]:bg-[color-mix(in_oklab,var(--background)_96%,var(--foreground))]"
            data-testid="workflow-inspector"
          >
            <div className="@container space-y-5 p-4 @min-[960px]:min-h-0 @min-[960px]:flex-1 @min-[960px]:overflow-y-auto">
              <ActionError message={mutation.error} />
              <ActionError message={preview.error} />
              {selection && view !== "list" ? (
                <WorkflowJobInspector
                  source={source}
                  selection={selection}
                  edit={edit}
                  onClose={() => selectWorkflowItem(null)}
                  onEditYaml={editJobYaml}
                  expandedSteps={expandedSteps}
                  onExpandedStepsChange={changeExpandedSteps}
                  stepToReveal={stepToReveal}
                />
              ) : (
                <>
                  <Tabs
                    tabs={[
                      {
                        key: "workflow",
                        label: c.workflowStep,
                        leading: <Icon name="play-circle" className="size-4" />,
                      },
                      {
                        key: "rules",
                        label: c.rulesStep,
                        leading: <Icon name="settings" className="size-4" />,
                      },
                    ]}
                    value={step}
                    onChange={setStep}
                    idPrefix={`${prefix}-settings`}
                    fullWidth
                    size="sm"
                  />
                  <div
                    role="tabpanel"
                    id={`${prefix}-settings-panel-${step}`}
                    aria-labelledby={`${prefix}-settings-tab-${step}`}
                    className="space-y-5"
                  >
                    {step === "workflow" ? (
                      <>
                        <ActionField label={a.name}>
                          <Input
                            variant="filled"
                            value={name}
                            maxLength={100}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="CI"
                          />
                        </ActionField>
                        <Tabs
                          tabs={[
                            { key: "repository", label: a.repository, icon: "github" },
                            { key: "standalone", label: c.standalone, icon: "terminal" },
                          ]}
                          value={standalone ? "standalone" : "repository"}
                          onChange={(value) => chooseStandalone(value === "standalone")}
                          idPrefix={prefix}
                          size="sm"
                          fullWidth
                        />
                        <div
                          role="tabpanel"
                          id={`${prefix}-panel-${standalone ? "standalone" : "repository"}`}
                          aria-labelledby={`${prefix}-tab-${standalone ? "standalone" : "repository"}`}
                          className="space-y-4"
                        >
                          {standalone ? (
                            <p className="text-xs leading-relaxed text-muted-foreground">
                              {c.standaloneHint}
                            </p>
                          ) : (
                            <>
                              <ActionField label={a.controller.label}>
                                <Tabs
                                  tabs={[
                                    { key: "github", label: "GitHub Actions", icon: "github" },
                                    {
                                      key: "openship",
                                      label: "Openship Actions",
                                      icon: "play-circle",
                                    },
                                  ]}
                                  value={controller}
                                  onChange={(value) => {
                                    setController(value);
                                    if (value === "github") setMode("repository");
                                  }}
                                  columns={2}
                                  size="sm"
                                  idPrefix={`${prefix}-controller`}
                                />
                                <p
                                  role="tabpanel"
                                  id={`${prefix}-controller-panel-${controller}`}
                                  aria-labelledby={`${prefix}-controller-tab-${controller}`}
                                  className="mt-2 text-xs leading-relaxed text-muted-foreground"
                                >
                                  {native ? a.controller.githubHint : a.controller.openshipHint}
                                </p>
                              </ActionField>
                              <ActionField label={a.repository}>
                                <Input
                                  variant="filled"
                                  value={repository}
                                  onChange={(event) => {
                                    setRepository(event.target.value);
                                    setOriginal(null);
                                  }}
                                  placeholder={a.repositoryHint}
                                />
                              </ActionField>
                              <div className="flex items-center justify-between gap-2">
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => setPicker(true)}
                                >
                                  <Icon name="github" />
                                  {c.chooseRepo}
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => {
                                    files.refresh();
                                    file.refresh();
                                  }}
                                  disabled={files.loading || file.loading}
                                  aria-label={e.checkUpdates}
                                  title={e.checkUpdates}
                                >
                                  <Icon name="refresh" />
                                </Button>
                              </div>
                              {repositoryValid && (
                                <>
                                  <ActionField label={a.ref}>
                                    <RepositoryBranchSelect
                                      owner={owner!}
                                      repo={repo!}
                                      value={ref}
                                      onChange={setRef}
                                    />
                                  </ActionField>
                                  <ActionField label={a.workflowFile}>
                                    {files.data?.length ? (
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
                                        onChange={(event) => setPath(event.target.value)}
                                      />
                                    )}
                                  </ActionField>
                                </>
                              )}
                              <ActionError
                                message={files.error ?? file.error ?? file.data?.error}
                                onRetry={() => {
                                  files.refresh();
                                  file.refresh();
                                }}
                              />
                              {repositoryValid &&
                                files.data?.length === 0 &&
                                !files.loading &&
                                !files.error && (
                                  <p className="text-xs text-muted-foreground">{c.noFiles}</p>
                                )}
                              {!native && (
                                <div className="space-y-2">
                                  <h2 className="text-sm font-medium">{e.updates}</h2>
                                  <Tabs
                                    tabs={[
                                      {
                                        key: "repository",
                                        label: e.automatic,
                                        leading: <Icon name="refresh" className="size-3.5" />,
                                      },
                                      {
                                        key: "inline",
                                        label: e.review,
                                        leading: <Icon name="shield-check" className="size-3.5" />,
                                      },
                                    ]}
                                    value={mode}
                                    onChange={(mode) => {
                                      setMode(mode);
                                      if (mode === "inline" && !source) setSource(STARTER);
                                    }}
                                    columns={2}
                                    idPrefix={`${prefix}-updates`}
                                    size="sm"
                                  />
                                  <p
                                    role="tabpanel"
                                    id={`${prefix}-updates-panel-${mode}`}
                                    aria-labelledby={`${prefix}-updates-tab-${mode}`}
                                    className="text-xs leading-relaxed text-muted-foreground"
                                  >
                                    {mode === "repository" ? e.automaticHint : e.reviewHint}
                                  </p>
                                </div>
                              )}
                              {differsFromRepository && (
                                <div className="space-y-2 rounded-xl bg-warning-bg p-3">
                                  <p className="flex items-start gap-2 text-xs leading-relaxed text-warning">
                                    <Icon name="git-branch" className="mt-0.5 size-4 shrink-0" />
                                    {e.repoDifferent}
                                  </p>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="-ms-2"
                                    onClick={() => reviewSource("incoming")}
                                  >
                                    {e.compare}
                                  </Button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <WorkflowTriggers
                          source={source}
                          onChange={setSource}
                          standalone={standalone}
                          embedded
                        />
                        <div className="space-y-3">
                          <h2 className="flex items-center gap-2 text-sm font-semibold">
                            <Icon name="server" className="size-4 text-muted-foreground" />
                            {a.destinations}
                          </h2>
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {native ? a.controller.labelsHint : a.destinationsHint}
                          </p>
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
                                      checked
                                        ? [...ids, runner.id]
                                        : ids.filter((id) => id !== runner.id),
                                    )
                                  }
                                />
                                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                                  <Icon
                                    name={runner.kind === "cloud" ? "cloud" : "server"}
                                    className="size-4"
                                  />
                                </span>
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-medium">
                                    {runner.name}
                                  </span>
                                  <span className="mt-0.5 block text-xs text-muted-foreground">
                                    {runner.labels.join(" · ")}
                                  </span>
                                </span>
                              </label>
                            ))}
                            <div className="flex items-center justify-between gap-2">
                              <Button variant="ghost" size="sm" asChild>
                                <Link
                                  href="/actions/runners/new"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <Icon name="plus" />
                                  {a.newRunner}
                                </Link>
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={refresh}
                                aria-label={a.refresh}
                              >
                                <Icon name="refresh" />
                              </Button>
                            </div>
                            {!selfHosted && !runners.some((runner) => runner.kind === "cloud") && (
                              <Button asChild variant="secondary" className="w-full">
                                <Link
                                  href="/actions/billing"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {a.setup.prepareCloud}
                                </Link>
                              </Button>
                            )}
                          </div>
                        </div>
                        <div className="space-y-3">
                          <h2 className="flex items-center gap-2 text-sm font-semibold">
                            <Icon name="project" className="size-4 text-muted-foreground" />
                            {c.projects}
                          </h2>
                          {projects.length ? (
                            <div className="space-y-2">
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
                        </div>
                        {!native && (
                          <details className="group">
                            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold">
                              <span className="flex items-center gap-2">
                                <Icon name="layers" className="size-4 text-muted-foreground" />
                                {c.environment}
                              </span>
                              <Icon name="chevron-down" className="size-4 group-open:rotate-180" />
                            </summary>
                            <div className="mt-4 space-y-5">
                              <div>
                                <h3 className="mb-3 text-sm font-medium">{a.variables}</h3>
                                <ActionValues values={variables} onChange={setVariables} />
                              </div>
                              <div>
                                <h3 className="mb-1 text-sm font-medium">{a.secrets}</h3>
                                <p className="mb-3 text-xs text-muted-foreground">
                                  {a.secretsHint}
                                </p>
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
                        )}
                        {native && (
                          <label className="flex items-start gap-2 text-sm">
                            <Checkbox checked={trusted} onCheckedChange={setTrusted} />
                            <span className="text-xs leading-relaxed text-muted-foreground">
                              {a.controller.trust}
                            </span>
                          </label>
                        )}
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox checked={enabled} onCheckedChange={setEnabled} />
                          {a.enabled}
                        </label>
                        {!standalone && !native && (
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
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
            <div className="shrink-0 space-y-3 p-4 pt-3">
              <p className="text-xs leading-relaxed text-muted-foreground">{e.draftHint}</p>
              {step === "workflow" && !runnerIds.length ? (
                <Button
                  className="w-full"
                  disabled={!readySource}
                  onClick={() => {
                    setSelection(null);
                    setStep("rules");
                  }}
                >
                  {c.continue}
                  <Icon name="arrow-right" className="rtl:rotate-180" />
                </Button>
              ) : (
                <Button
                  className="w-full"
                  disabled={!canSave}
                  onClick={() => (dirty ? reviewSource("save") : void save(false))}
                >
                  {mutation.busy ? a.saving : a.save}
                </Button>
              )}
            </div>
          </aside>
        </div>
      </div>
      {picker && (
        <RepositoryPicker
          onClose={() => setPicker(false)}
          onSelect={(owner, repository) => {
            setRepository(`${owner}/${repository.name}`);
            setRef(repository.default_branch || "main");
            setMode("repository");
            setOriginal(null);
            loaded.current = null;
            draft.reset("");
            setSelection(null);
            setPicker(false);
          }}
        />
      )}
      {review && (
        <SourceReview
          snapshot={review}
          onClose={() => setReview(null)}
          busy={mutation.busy}
          error={mutation.error}
          onCommit={() => void save(true, review)}
          onCopy={native ? undefined : () => void save(false, review)}
          onApply={() => {
            setSource(review.previous);
            setReview(null);
          }}
        />
      )}
    </div>
  );
}
interface SourceReviewSnapshot {
  kind: "save" | "incoming";
  source: string;
  previous: string;
  sha: string;
  identity: string;
}

function SourceReview({
  snapshot,
  onClose,
  onCommit,
  onCopy,
  onApply,
  busy,
  error,
}: {
  snapshot: SourceReviewSnapshot;
  onClose: () => void;
  onCommit: () => void;
  onCopy?: () => void;
  onApply: () => void;
  busy: boolean;
  error: string | null;
}) {
  const { t } = useI18n();
  const c = t.actions.integration;
  const e = t.actions.editor;
  const { source, previous, kind } = snapshot;
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
          {kind === "incoming" ? e.reviewRepository : c.reviewChanges}
        </h2>
        <p className="text-sm text-muted-foreground">
          {kind === "incoming" ? e.reviewRepositoryHint : e.saveReviewHint}
        </p>
        <ActionError message={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          {[
            [e.repositoryVersion, previous],
            [e.yourDraft, source],
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
          {kind === "incoming" ? (
            <Button onClick={onApply} disabled={busy}>
              {e.applyRepository}
            </Button>
          ) : (
            <>
              {onCopy && (
                <Button variant="secondary" onClick={onCopy} disabled={busy}>
                  {c.saveCopy}
                </Button>
              )}
              <Button onClick={onCommit} disabled={busy}>
                {c.commitSave}
              </Button>
            </>
          )}
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
