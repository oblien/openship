"use client";
import { useCallback, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { actionsApi } from "@/lib/api/actions";
import { useDeployment } from "@/context/DeploymentContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/button";
import { ActionError } from "./ActionStatus";
import { WorkflowSetupDialog } from "./WorkflowSetup";
import { ActionDeploymentRules } from "./ProjectActions";
import { useActionResource } from "./useActions";

/** Discovery is shared; setup stays in the wizard and never discards deployment fields. */
export function DeployActions() {
  const { config, updateConfig } = useDeployment();
  const { t } = useI18n();
  const a = t.actions,
    c = a.integration;
  const [open, setOpen] = useState(false);
  const repository =
    config.owner && config.repo && !config.localPath && !config.uploadSessionId && !config.isApp;
  const workflows = useActionResource(
    useCallback(async () => {
      if (!repository) return { files: [], workflows: [], policy: null };
      const [files, workflows, policy] = await Promise.all([
        actionsApi.discover(config.owner, config.repo, config.branch),
        actionsApi.list(),
        config.projectId ? actionsApi.projectPolicy(config.projectId) : Promise.resolve(null),
      ]);
      return { files, workflows, policy };
    }, [repository, config.owner, config.repo, config.branch, config.projectId]),
  );
  if (!repository) return null;
  const value = config.actions ?? workflows.data?.policy ?? undefined;
  const available =
    workflows.data?.workflows.filter(
      (w) =>
        w.owner?.toLowerCase() === config.owner.toLowerCase() &&
        w.repo?.toLowerCase() === config.repo.toLowerCase(),
    ) ?? [];
  return (
    <section className="space-y-4 rounded-2xl bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Icon name="play-circle" className="size-5 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">{a.title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {workflows.data?.files.length
                ? interpolate(c.discovered, { count: String(workflows.data.files.length) })
                : c.wizardHint}
            </p>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          {a.newWorkflow}
        </Button>
      </div>
      {!!available.length && (
        <div className="flex flex-wrap gap-3">
          {available.map((workflow) => (
            <label key={workflow.id} className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={value?.workflowIds.includes(workflow.id) ?? false}
                onCheckedChange={(checked) =>
                  updateConfig({
                    actions: {
                      mode: value?.mode ?? "manual",
                      workflowIds: checked
                        ? [...new Set([...(value?.workflowIds ?? []), workflow.id])]
                        : (value?.workflowIds.filter((id) => id !== workflow.id) ?? []),
                      requiredWorkflowIds:
                        value?.requiredWorkflowIds.filter((id) => checked || id !== workflow.id) ??
                        [],
                    },
                  })
                }
              />
              {workflow.name}
            </label>
          ))}
        </div>
      )}
      {value && (
        <>
          <p className="text-xs text-muted-foreground">{c.linkOnCreate}</p>
          <ActionDeploymentRules
            project={{ owner: config.owner, repo: config.repo, branch: config.branch }}
            workflows={available}
            value={value}
            onChange={(actions) => updateConfig({ actions })}
          />
        </>
      )}
      <ActionError message={workflows.error} onRetry={workflows.refresh} />
      {open && (
        <WorkflowSetupDialog
          initial={{
            owner: config.owner,
            repo: config.repo,
            ref: config.branch,
            projectId: config.projectId,
            path: workflows.data?.files[0]?.path,
          }}
          onCancel={() => setOpen(false)}
          onSaved={(workflow, saved = [workflow]) => {
            updateConfig({
              actions: {
                mode: value?.mode ?? "manual",
                workflowIds: [
                  ...new Set([...(value?.workflowIds ?? []), ...saved.map((item) => item.id)]),
                ],
                requiredWorkflowIds: value?.requiredWorkflowIds ?? [],
              },
            });
            workflows.refresh();
            setOpen(false);
          }}
        />
      )}
    </section>
  );
}
