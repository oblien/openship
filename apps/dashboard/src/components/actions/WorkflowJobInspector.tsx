"use client";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";
import { CustomSelect } from "@/components/ui/CustomSelect";
import type { TopologySelection } from "@/components/topology/TopologyCanvas";
import { useI18n } from "@/components/i18n-provider";
import { ActionField } from "./ActionField";
import { DraftInput } from "./DraftText";
import { workflowEventConfig as object } from "./workflow-yaml";
import {
  editWorkflowJob,
  editWorkflowStep,
  editWorkflowDependency,
  removeWorkflowJob,
  changeWorkflowSteps,
  workflowJobs,
} from "./workflow-editor";

type Edit = (operation: () => string) => void;
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";

export function WorkflowJobInspector({
  source,
  selection,
  edit,
  onClose,
  onEditYaml,
}: {
  source: string;
  selection: NonNullable<TopologySelection>;
  edit: Edit;
  onClose: () => void;
  onEditYaml: () => void;
}) {
  const { t } = useI18n();
  const e = t.actions.editor;
  let jobs: ReturnType<typeof workflowJobs>;
  try {
    jobs = workflowJobs(source);
  } catch {
    // diagnostics-ignore: Invalid user YAML is displayed beside its editor and is never sent to diagnostics.
    return (
      <div className="space-y-4">
        <InspectorBack onClose={onClose} />
        <p className="text-sm text-muted-foreground">{t.actions.integration.fixYaml}</p>
      </div>
    );
  }
  if (selection.kind === "edge") {
    const [from, to] = selection.id.split(":");
    return (
      <div className="space-y-5">
        <InspectorBack onClose={onClose} />
        <h2 className="flex items-center gap-3 text-base font-medium">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-info-bg text-info">
            <Icon name="git-branch" className="size-5" />
          </span>
          {e.connection}
        </h2>
        <div className="space-y-3 rounded-xl bg-background p-4 text-sm">
          <p className="break-words font-medium">
            {(jobs.find((job) => job.id === from)?.value.name as string) || from}
          </p>
          <Icon name="arrow-down" className="size-4 text-info" />
          <p className="break-words font-medium">
            {(jobs.find((job) => job.id === to)?.value.name as string) || to}
          </p>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{e.connectionHint}</p>
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => edit(() => editWorkflowDependency(source, from!, to!, false))}
        >
          <Icon name="close" />
          {e.removeConnection}
        </Button>
      </div>
    );
  }
  const job = jobs.find((job) => job.id === selection.id);
  if (!job) return <InspectorBack onClose={onClose} />;
  const { id, value } = job;
  const needs =
    typeof value.needs === "string" ? [value.needs] : Array.isArray(value.needs) ? value.needs : [];
  const steps = Array.isArray(value.steps) ? value.steps : [];
  const field = (key: string, value: unknown) =>
    edit(() => editWorkflowJob(source, id, key, value));
  return (
    <div className="space-y-5" data-testid="workflow-job-inspector">
      <InspectorBack onClose={onClose} />
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-success-bg text-success">
          <Icon name="terminal" className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-base font-medium">{text(value.name) || id}</h2>
          <code className="text-xs text-muted-foreground">{id}</code>
        </div>
      </div>
      <ActionField label={t.actions.name}>
        <Input
          variant="filled"
          value={text(value.name)}
          placeholder={id}
          onChange={(event) => field("name", event.target.value)}
        />
      </ActionField>
      <ActionField label={e.runsOn} hint={e.runsOnHint}>
        <DraftInput
          variant="filled"
          dir="ltr"
          value={
            Array.isArray(value["runs-on"]) ? value["runs-on"].join(", ") : text(value["runs-on"])
          }
          disabled={
            !!value["runs-on"] &&
            typeof value["runs-on"] === "object" &&
            !Array.isArray(value["runs-on"])
          }
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
      <details className="group" open={needs.length > 0 || undefined}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">
            <Icon name="git-branch" className="size-4 text-info" />
            {e.dependencies}
            {needs.length ? ` · ${needs.length}` : ""}
          </span>
          <Icon
            name="chevron-down"
            className="size-4 text-muted-foreground group-open:rotate-180"
          />
        </summary>
        <div className="mt-3 space-y-2">
          {jobs
            .filter((other) => other.id !== id)
            .map((other) => (
              <label
                className="flex cursor-pointer items-center gap-2 rounded-lg bg-background/60 p-2.5 text-sm"
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
          {jobs.length === 1 && <p className="text-xs text-muted-foreground">{e.noDependencies}</p>}
        </div>
      </details>
      <div className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Icon name="list-check" className="size-4 text-success" />
          {e.steps} <span className="ms-1 text-muted-foreground">{steps.length}</span>
        </h3>
        {steps.map((raw, index) => {
          const step = object(raw);
          const isAction = Object.hasOwn(step, "uses");
          const update = (patch: Record<string, unknown>) =>
            edit(() => editWorkflowStep(source, id, index, patch));
          return (
            <details className="group rounded-xl bg-background/60" key={index}>
              <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm">
                <span
                  className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${isAction ? "bg-info-bg text-info" : "bg-success-bg text-success"}`}
                >
                  <Icon name={isAction ? "bolt" : "terminal"} className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {text(step.name) || text(step.uses) || text(step.run).split("\n")[0]}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                <Icon
                  name="chevron-down"
                  className="size-3.5 shrink-0 text-muted-foreground group-open:rotate-180"
                />
              </summary>
              <div className="space-y-3 px-3 pb-3">
                <ActionField label={t.actions.name}>
                  <Input
                    variant="filled"
                    value={text(step.name)}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                </ActionField>
                <CustomSelect
                  aria-label={e.stepType}
                  value={isAction ? "action" : "command"}
                  variant="filled"
                  triggerClassName="bg-muted/60 hover:bg-muted"
                  options={[
                    { value: "command", label: e.command },
                    { value: "action", label: e.action },
                  ]}
                  onChange={(kind) =>
                    update(
                      kind === "command"
                        ? { run: "echo 'New step'", uses: undefined, with: undefined }
                        : {
                            uses: "actions/checkout@v4",
                            run: undefined,
                            shell: undefined,
                            "working-directory": undefined,
                          },
                    )
                  }
                />
                <ActionField label={isAction ? e.action : e.command}>
                  {isAction ? (
                    <Input
                      variant="filled"
                      dir="ltr"
                      value={text(step.uses)}
                      onChange={(event) => update({ uses: event.target.value })}
                    />
                  ) : (
                    <textarea
                      dir="ltr"
                      spellCheck={false}
                      className="min-h-28 w-full resize-y rounded-xl bg-background p-3 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={text(step.run)}
                      onChange={(event) => update({ run: event.target.value })}
                    />
                  )}
                </ActionField>
                <div className="flex items-center justify-between">
                  <div className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={index === 0}
                      aria-label={e.moveUp}
                      onClick={() => edit(() => changeWorkflowSteps(source, id, index, "up"))}
                    >
                      <Icon name="arrow-down" className="rotate-180" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={index === steps.length - 1}
                      aria-label={e.moveDown}
                      onClick={() => edit(() => changeWorkflowSteps(source, id, index, "down"))}
                    >
                      <Icon name="arrow-down" />
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => edit(() => changeWorkflowSteps(source, id, index, "remove"))}
                  >
                    {t.actions.remove}
                  </Button>
                </div>
              </div>
            </details>
          );
        })}
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={() => edit(() => changeWorkflowSteps(source, id, 0, "add"))}
        >
          <Icon name="plus" className="text-success" />
          {e.addStep}
        </Button>
      </div>
      <div className="space-y-2">
        <p className="text-xs leading-relaxed text-muted-foreground">{e.jobYamlHint}</p>
        <Button variant="secondary" size="sm" className="w-full" onClick={onEditYaml}>
          <Icon name="code" className="text-info" />
          {e.editJobYaml}
        </Button>
      </div>
      <Button
        variant="ghost"
        className="w-full text-destructive"
        onClick={() => edit(() => removeWorkflowJob(source, id))}
      >
        <Icon name="trash" />
        {e.removeJob}
      </Button>
    </div>
  );
}

function InspectorBack({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Button size="sm" variant="ghost" className="-ms-3" onClick={onClose}>
      <Icon name="arrow-left" className="rtl:rotate-180" />
      {t.actions.editor.backToWorkflow}
    </Button>
  );
}
