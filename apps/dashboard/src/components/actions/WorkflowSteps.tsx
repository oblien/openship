"use client";
import { useId } from "react";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useI18n } from "@/components/i18n-provider";
import { ActionField } from "./ActionField";
import { workflowEventConfig as object } from "./workflow-yaml";
import { changeWorkflowSteps, editWorkflowStep, type WorkflowEdit } from "./workflow-editor";

export type WorkflowStepSelection = { jobId: string; index: number } | null;
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";

/** The same inline editor lives in the list or the topology inspector, never both. */
export function WorkflowSteps({
  source,
  jobId,
  steps,
  selection,
  onSelect,
  edit,
}: {
  source: string;
  jobId: string;
  steps: unknown[];
  selection: WorkflowStepSelection;
  onSelect: (selection: WorkflowStepSelection) => void;
  edit: WorkflowEdit;
}) {
  const { t } = useI18n();
  const e = t.actions.editor;
  const prefix = useId();
  const changeOrder = (index: number, action: "up" | "down" | "remove") =>
    edit(() => {
      const next = changeWorkflowSteps(source, jobId, index, action);
      onSelect(action === "remove" ? null : { jobId, index: index + (action === "up" ? -1 : 1) });
      return next;
    });
  return (
    <div className="@container space-y-2" data-testid="workflow-steps">
      <ol aria-label={e.steps}>
        {steps.map((raw, index) => {
          const step = object(raw);
          const isAction = Object.hasOwn(step, "uses");
          const selected = selection?.jobId === jobId && selection.index === index;
          const update = (patch: Record<string, unknown>) =>
            edit(() => editWorkflowStep(source, jobId, index, patch));
          const title =
            text(step.name) || text(step.uses) || text(step.run).split("\n")[0] || e.command;
          const id = `${prefix}-${index}`;
          return (
            <li key={index} className="relative pb-1 last:pb-0">
              {index < steps.length - 1 && (
                <span aria-hidden className="absolute bottom-0 start-[19px] top-8 w-px bg-border" />
              )}
              <button
                type="button"
                aria-expanded={selected}
                aria-controls={id}
                onClick={() => onSelect(selected ? null : { jobId, index })}
                className={`relative flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-start text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring ${selected ? "bg-muted/60" : "hover:bg-muted/40"}`}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-card text-muted-foreground">
                  <Icon name={isAction ? "bolt" : "terminal"} className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                <Icon
                  name="chevron-down"
                  className={`size-3.5 shrink-0 text-muted-foreground ${selected ? "rotate-180" : ""}`}
                />
              </button>
              <div
                id={id}
                hidden={!selected}
                className="ms-[19px] space-y-3 border-s border-border py-3 ps-4 pe-1"
              >
                {selected && (
                  <>
                    <div className="grid gap-3 @min-[320px]:grid-cols-2">
                      <ActionField label={t.actions.name}>
                        <Input
                          className="h-9"
                          variant="filled"
                          value={text(step.name)}
                          onChange={(event) => update({ name: event.target.value })}
                        />
                      </ActionField>
                      <ActionField label={e.stepType}>
                        <CustomSelect
                          aria-label={e.stepType}
                          value={isAction ? "action" : "command"}
                          variant="filled"
                          triggerClassName="h-9 bg-muted/60 hover:bg-muted"
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
                      </ActionField>
                    </div>
                    <ActionField label={isAction ? e.action : e.command}>
                      {isAction ? (
                        <Input
                          className="h-9"
                          variant="filled"
                          dir="ltr"
                          value={text(step.uses)}
                          onChange={(event) => update({ uses: event.target.value })}
                        />
                      ) : (
                        <textarea
                          dir="ltr"
                          aria-label={e.command}
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
                          onClick={() => changeOrder(index, "up")}
                        >
                          <Icon name="arrow-down" className="rotate-180" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={index === steps.length - 1}
                          aria-label={e.moveDown}
                          onClick={() => changeOrder(index, "down")}
                        >
                          <Icon name="arrow-down" />
                        </Button>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => changeOrder(index, "remove")}
                      >
                        {t.actions.remove}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <Button
        size="sm"
        variant="ghost"
        className="w-full justify-start"
        onClick={() =>
          edit(() => {
            const next = changeWorkflowSteps(source, jobId, 0, "add");
            onSelect({ jobId, index: steps.length });
            return next;
          })
        }
      >
        <Icon name="plus" />
        {e.addStep}
      </Button>
    </div>
  );
}
