"use client";
import { useId, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useI18n } from "@/components/i18n-provider";
import { ActionField } from "./ActionField";
import { DraftInput } from "./DraftText";
import {
  WorkflowSteps,
  type WorkflowExpandedSteps,
  type WorkflowStepTarget,
} from "./WorkflowSteps";
import { workflowEventConfig as object } from "./workflow-yaml";
import {
  editWorkflowContainerImage,
  editWorkflowDependency,
  editWorkflowJob,
  editWorkflowJobArchitecture,
  removeWorkflowJob,
  workflowJobArchitecture,
  type workflowJobs,
  type WorkflowEdit,
} from "./workflow-editor";

type Job = ReturnType<typeof workflowJobs>[number];
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";

/** Shared job settings and steps: inline in List, in the inspector for Topology. */
export function WorkflowJobEditor({
  source,
  job,
  jobs,
  edit,
  expandedSteps,
  onExpandedStepsChange,
  stepToReveal,
  onEditYaml,
  inline = false,
}: {
  source: string;
  job: Job;
  jobs: Job[];
  edit: WorkflowEdit;
  expandedSteps: WorkflowExpandedSteps;
  onExpandedStepsChange: (expanded: WorkflowExpandedSteps) => void;
  stepToReveal?: WorkflowStepTarget | null;
  onEditYaml: (id: string) => void;
  inline?: boolean;
}) {
  const { t } = useI18n();
  const e = t.actions.editor;
  const [settings, setSettings] = useState(!inline);
  const prefix = useId();
  const { id, value } = job;
  const reusable = typeof value.uses === "string";
  const runsOn = value["runs-on"];
  const runnerLabels = Array.isArray(runsOn) ? runsOn.join(", ") : text(runsOn);
  const complex =
    (!!runsOn && typeof runsOn === "object" && !Array.isArray(runsOn)) ||
    runnerLabels.includes("${{");
  const image =
    typeof value.container === "string" ? value.container : text(object(value.container).image);
  const needs =
    typeof value.needs === "string" ? [value.needs] : Array.isArray(value.needs) ? value.needs : [];
  const steps = Array.isArray(value.steps) ? value.steps : [];
  const field = (key: string, next: unknown) => edit(() => editWorkflowJob(source, id, key, next));
  return (
    <div className="@container space-y-3" data-testid="workflow-job-editor">
      <button
        type="button"
        aria-label={e.jobSettings}
        aria-expanded={settings}
        aria-controls={`${prefix}-settings`}
        onClick={() => setSettings((current) => !current)}
        className={`flex w-full items-center gap-2.5 rounded-lg text-start focus-visible:outline-2 focus-visible:outline-ring ${inline ? "px-2 py-2 text-xs text-muted-foreground hover:bg-muted/40" : "py-1"}`}
      >
        <Icon
          name={inline ? "settings" : "play-circle"}
          className={inline ? "size-3.5" : "size-5 shrink-0 text-info/80"}
        />
        <span className="min-w-0 flex-1">
          <span className={`block truncate ${inline ? "" : "text-sm font-medium text-foreground"}`}>
            {inline ? e.jobSettings : text(value.name) || id}
          </span>
          {!inline && !reusable && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {runnerLabels || id}
            </span>
          )}
        </span>
        <Icon
          name="chevron-down"
          className={`size-3.5 shrink-0 text-muted-foreground ${settings ? "rotate-180" : ""}`}
        />
      </button>
      <div id={`${prefix}-settings`} hidden={!settings} className="space-y-3 pb-2">
        <div className="grid gap-3 @min-[320px]:grid-cols-2">
          <ActionField label={t.actions.name}>
            <Input
              className="h-9"
              variant="filled"
              value={text(value.name)}
              placeholder={id}
              onChange={(event) => field("name", event.target.value)}
            />
          </ActionField>
          {!reusable && (
            <ActionField label={e.architecture}>
              <CustomSelect
                aria-label={e.architecture}
                value={workflowJobArchitecture(runsOn)}
                variant="filled"
                triggerClassName="h-9 bg-muted/60 hover:bg-muted"
                disabled={complex}
                options={[
                  { value: "auto", label: e.automaticArchitecture },
                  { value: "x64", label: "x64" },
                  { value: "arm64", label: "ARM64" },
                ]}
                onChange={(architecture) =>
                  edit(() => editWorkflowJobArchitecture(source, id, architecture))
                }
              />
            </ActionField>
          )}
        </div>
        {reusable ? (
          <ActionField label={t.actions.controller.reusable}>
            <DraftInput
              variant="filled"
              className="h-9"
              dir="ltr"
              value={text(value.uses)}
              onChange={(event) => field("uses", event.target.value)}
            />
          </ActionField>
        ) : (
          <>
            <ActionField label={e.runsOn}>
              <DraftInput
                className="h-9"
                variant="filled"
                dir="ltr"
                value={runnerLabels}
                title={e.runsOnHint}
                disabled={!!runsOn && typeof runsOn === "object" && !Array.isArray(runsOn)}
                onChange={(event) => {
                  if (event.target.value.includes("${{")) {
                    field("runs-on", event.target.value);
                    return;
                  }
                  const labels = event.target.value
                    .split(",")
                    .map((label) => label.trim())
                    .filter(Boolean);
                  field("runs-on", labels.length === 1 ? labels[0] : labels);
                }}
              />
            </ActionField>
            <div className="space-y-2">
              <ActionField label={e.jobImage}>
                <DraftInput
                  className="h-9"
                  variant="filled"
                  dir="ltr"
                  value={image}
                  placeholder={e.runnerDefault}
                  onChange={(event) =>
                    edit(() => editWorkflowContainerImage(source, id, event.target.value))
                  }
                />
              </ActionField>
              <div className="flex flex-wrap gap-1.5">
                {value.container !== undefined && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => field("container", undefined)}
                  >
                    {e.runnerDefault}
                  </Button>
                )}
                {["node:22", "node:24"].map((image) => (
                  <Button
                    key={image}
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-xs"
                    onClick={() => edit(() => editWorkflowContainerImage(source, id, image))}
                  >
                    <Icon name="docker" className="size-3.5" />
                    {image}
                  </Button>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{e.jobImageHint}</p>
            </div>
          </>
        )}
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-1.5 text-xs font-medium">
            <span className="flex items-center gap-2">
              <Icon name="git-branch" className="size-3.5 text-muted-foreground" />
              {e.dependencies}
              {needs.length ? ` · ${needs.length}` : ""}
            </span>
            <Icon
              name="chevron-down"
              className="size-3.5 text-muted-foreground group-open:rotate-180"
            />
          </summary>
          <div className="mt-2 space-y-2">
            {jobs
              .filter((other) => other.id !== id)
              .map((other) => (
                <label
                  className="flex cursor-pointer items-center gap-2 rounded-lg bg-background/60 p-2 text-sm"
                  key={other.id}
                >
                  <Checkbox
                    checked={needs.includes(other.id)}
                    onCheckedChange={(enabled) =>
                      edit(() => editWorkflowDependency(source, other.id, id, enabled))
                    }
                  />
                  <span className="truncate">{text(other.value.name) || other.id}</span>
                </label>
              ))}
            {jobs.length === 1 && (
              <p className="text-xs text-muted-foreground">{e.noDependencies}</p>
            )}
          </div>
        </details>
      </div>
      {!inline && !reusable && (
        <h3 className="flex items-center justify-between text-xs font-medium text-muted-foreground">
          <span>{e.steps}</span>
          <span>{steps.length}</span>
        </h3>
      )}
      {!reusable && (
        <WorkflowSteps
          source={source}
          jobId={id}
          steps={steps}
          edit={edit}
          expandedSteps={expandedSteps}
          onExpandedStepsChange={onExpandedStepsChange}
          reveal={stepToReveal}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          title={e.jobYamlHint}
          onClick={() => onEditYaml(id)}
        >
          <Icon name="code" className="size-3.5" />
          {e.editJobYaml}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-destructive"
          onClick={() => edit(() => removeWorkflowJob(source, id))}
        >
          <Icon name="trash" className="size-3.5" />
          {e.removeJob}
        </Button>
      </div>
    </div>
  );
}
