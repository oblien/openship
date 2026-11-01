"use client";
import { useCallback, useId, useState } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import type { ActionProjectPolicy, ActionWorkflowView, ActionProjectView } from "@repo/contracts";
import { actionsApi } from "@/lib/api/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { OptionCard } from "@/components/shared/OptionCard";
import { Tabs } from "@/components/ui/Tabs";
import { useI18n } from "@/components/i18n-provider";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { ActionError } from "./ActionStatus";
import { ActionRunList } from "./ActionsHome";
import { ActionsEmptyState } from "./ActionsEmptyState";
import { WorkflowSetupDialog } from "./WorkflowSetup";
import { useActionMutation, useActionResource, useActionScope } from "./useActions";

export type ProjectActionSelection = Pick<
  ActionProjectPolicy,
  "mode" | "workflowIds" | "requiredWorkflowIds"
>;
export function ActionDeploymentRules({
  value,
  onChange,
  workflows,
  project,
}: {
  value: ProjectActionSelection;
  onChange: (value: ProjectActionSelection) => void;
  workflows: ActionWorkflowView[];
  project: Pick<ActionProjectView, "owner" | "repo" | "branch">;
}) {
  const { t } = useI18n();
  const c = t.actions.integration;
  const modes = [
    {
      mode: "manual" as const,
      label: c.deployManual,
      hint: c.deployManualHint,
      icon: "play" as const,
    },
    {
      mode: "push" as const,
      label: c.deployPush,
      hint: c.deployPushHint,
      icon: "git-branch" as const,
    },
    {
      mode: "actions" as const,
      label: c.deployActions,
      hint: c.deployActionsHint,
      icon: "play-circle" as const,
    },
  ];
  const eligible = workflows.filter(
    (w) =>
      w.enabled &&
      w.owner?.toLowerCase() === project.owner?.toLowerCase() &&
      w.repo?.toLowerCase() === project.repo?.toLowerCase() &&
      w.plan.triggers.includes("push"),
  );
  return (
    <section className="space-y-4 rounded-2xl bg-card p-5">
      <h2 className="text-sm font-semibold">{c.autoMode}</h2>
      <div className="space-y-2">
        {modes.map(({ mode, label, hint, icon }) => (
          <OptionCard
            key={mode}
            value={mode}
            selected={value.mode === mode}
            label={label}
            description={hint}
            icon={<Icon name={icon} className="size-4" />}
            disabled={mode !== "manual" && (!project.owner || !project.repo)}
            onSelect={() =>
              onChange({
                ...value,
                mode,
                requiredWorkflowIds: mode === "actions" ? value.requiredWorkflowIds : [],
              })
            }
          />
        ))}
      </div>
      {value.mode === "actions" && (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{c.requiredHint}</p>
          {eligible.map((workflow) => (
            <label key={workflow.id} className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={value.requiredWorkflowIds.includes(workflow.id)}
                onCheckedChange={(checked) =>
                  onChange({
                    ...value,
                    workflowIds: [...new Set([...value.workflowIds, workflow.id])],
                    requiredWorkflowIds: checked
                      ? [...value.requiredWorkflowIds, workflow.id]
                      : value.requiredWorkflowIds.filter((id) => id !== workflow.id),
                  })
                }
              />
              {workflow.name}
            </label>
          ))}
          {!eligible.length && <p className="text-xs text-muted-foreground">{c.noRequired}</p>}
        </div>
      )}
    </section>
  );
}
function PolicyForm({
  policy,
  workflows,
  refresh,
}: {
  policy: ActionProjectPolicy;
  workflows: ActionWorkflowView[];
  refresh: () => void;
}) {
  const { t } = useI18n();
  const c = t.actions.integration;
  const mutation = useActionMutation();
  const [value, setValue] = useState<ProjectActionSelection>({
    mode: policy.mode,
    workflowIds: policy.workflowIds,
    requiredWorkflowIds: policy.requiredWorkflowIds,
  });
  return (
    <div className="space-y-4">
      <ActionDeploymentRules
        project={policy.project}
        workflows={workflows}
        value={value}
        onChange={setValue}
      />
      <section className="space-y-3 rounded-2xl bg-card p-5">
        <h3 className="text-sm font-semibold">{c.linkedWorkflows}</h3>
        {workflows.map((workflow) => (
          <label key={workflow.id} className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={value.workflowIds.includes(workflow.id)}
              onCheckedChange={(checked) =>
                setValue((previous) => ({
                  ...previous,
                  workflowIds: checked
                    ? [...previous.workflowIds, workflow.id]
                    : previous.workflowIds.filter((id) => id !== workflow.id),
                  requiredWorkflowIds: checked
                    ? previous.requiredWorkflowIds
                    : previous.requiredWorkflowIds.filter((id) => id !== workflow.id),
                }))
              }
            />
            {workflow.name}
          </label>
        ))}
        <ActionError message={mutation.error} />
        <Button
          className="w-full"
          disabled={
            mutation.busy || (value.mode === "actions" && !value.requiredWorkflowIds.length)
          }
          onClick={async () => {
            if (
              await mutation.execute(() =>
                actionsApi.updateProjectPolicy({ ...value, projectId: policy.project.id }),
              )
            ) {
              invalidateProjectCaches(policy.project.id);
              refresh();
            }
          }}
        >
          {mutation.busy ? t.actions.saving : c.saveRules}
        </Button>
      </section>
    </div>
  );
}
function ProjectContent({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const a = t.actions,
    c = a.integration;
  const tabsId = useId();
  const [tab, setTab] = useState<"workflows" | "runs" | "rules">("workflows"),
    [editing, setEditing] = useState(false);
  const data = useActionResource(
    useCallback(async () => {
      const [policy, workflows, runs] = await Promise.all([
        actionsApi.projectPolicy(projectId),
        actionsApi.list(),
        actionsApi.runs(undefined, projectId),
      ]);
      return { policy, workflows, runs };
    }, [projectId]),
    8000,
  );
  const mutation = useActionMutation(),
    [retryKey, setRetryKey] = useState(() => crypto.randomUUID());
  const value = data.data;
  const linked = value?.workflows.filter((w) => value.policy.workflowIds.includes(w.id)) ?? [];
  return (
    <div className="@container space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          idPrefix={tabsId}
          ariaLabel={a.title}
          tabs={[
            { key: "workflows", label: a.workflows },
            { key: "runs", label: a.runs },
            { key: "rules", label: c.autoMode },
          ]}
          value={tab}
          onChange={setTab}
        />
        {value && (tab !== "workflows" || linked.length > 0) && (
          <Button onClick={() => setEditing(true)}>
            <Icon name="plus" />
            {a.newWorkflow}
          </Button>
        )}
      </div>
      <ActionError message={data.error} onRetry={data.refresh} />
      <ActionError message={mutation.error} />
      {value ? (
        <div
          className="space-y-5"
          role="tabpanel"
          id={`${tabsId}-panel-${tab}`}
          aria-labelledby={`${tabsId}-tab-${tab}`}
        >
          {tab === "rules" ? (
            <PolicyForm
              key={`${projectId}:${value.policy.mode}:${value.policy.workflowIds.join(":")}:${value.policy.requiredWorkflowIds.join(":")}`}
              policy={value.policy}
              workflows={value.workflows}
              refresh={data.refresh}
            />
          ) : (
            <div className="min-w-0 space-y-5">
              {value.policy.requests
                .filter((r) => !r.deploymentId)
                .slice(0, 3)
                .map((request) => (
                  <article key={request.id} className="space-y-3 rounded-2xl bg-card p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-medium">
                        {c.requestStatus[request.status as keyof typeof c.requestStatus] ??
                          request.status}
                      </h3>
                      <code className="text-xs text-muted-foreground">
                        {request.revision.slice(0, 7)}
                      </code>
                    </div>
                    {request.error && (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {request.error}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {["failed", "blocked", "cancelled"].includes(request.status) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={mutation.busy}
                          onClick={async () => {
                            if (
                              await mutation.execute(() =>
                                actionsApi.updateDeploymentRequest({
                                  projectId,
                                  requestId: request.id,
                                  action: "retry",
                                  idempotencyKey: retryKey,
                                }),
                              )
                            ) {
                              setRetryKey(crypto.randomUUID());
                              data.refresh();
                            }
                          }}
                        >
                          {a.retry}
                        </Button>
                      )}
                      {["waiting", "blocked", "deploying"].includes(request.status) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={mutation.busy}
                          onClick={async () => {
                            if (
                              await mutation.execute(() =>
                                actionsApi.updateDeploymentRequest({
                                  projectId,
                                  requestId: request.id,
                                  action: "cancel",
                                  idempotencyKey: retryKey,
                                }),
                              )
                            )
                              data.refresh();
                          }}
                        >
                          {a.cancel}
                        </Button>
                      )}
                    </div>
                  </article>
                ))}
              {tab === "runs" ? (
                <ActionRunList runs={value.runs} />
              ) : linked.length ? (
                <div className="grid gap-4 @min-[620px]:grid-cols-2">
                  {linked.map((workflow) => (
                    <Link
                      key={workflow.id}
                      href={`/actions/workflows/${workflow.id}`}
                      className="rounded-2xl bg-card p-5 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <div className="flex items-center gap-3">
                        <span className="rounded-xl bg-muted/50 p-2.5">
                          <Icon name="play-circle" className="size-5 text-muted-foreground" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {workflow.name}
                        </span>
                        <Icon
                          name="chevron-right"
                          className="size-4 text-muted-foreground rtl:rotate-180"
                        />
                      </div>
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <code>{workflow.path.split("/").pop()}</code>
                        <span>
                          {value.policy.requiredWorkflowIds.includes(workflow.id)
                            ? c.required
                            : c.optional}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <ActionsEmptyState title={a.emptyTitle} description={c.projectEmpty}>
                  <Button onClick={() => setEditing(true)}>
                    {a.newWorkflow}
                    <Icon name="arrow-right" className="rtl:rotate-180" />
                  </Button>
                </ActionsEmptyState>
              )}
            </div>
          )}
        </div>
      ) : data.loading ? (
        <div className="h-72 animate-pulse rounded-2xl bg-card" />
      ) : null}
      {editing && value && (
        <WorkflowSetupDialog
          initial={{
            projectId,
            owner: value.policy.project.owner ?? undefined,
            repo: value.policy.project.repo ?? undefined,
            ref: value.policy.project.branch ?? undefined,
          }}
          onSaved={() => {
            setEditing(false);
            data.refresh();
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
}
export function ProjectActions({ projectId }: { projectId: string }) {
  const scope = useActionScope();
  return <ProjectContent key={`${scope}:${projectId}`} projectId={projectId} />;
}
