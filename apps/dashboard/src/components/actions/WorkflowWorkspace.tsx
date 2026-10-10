"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { Connection } from "@xyflow/react";
import type { ActionPlanView } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/Tabs";
import { optionCardSurface } from "@/components/shared/OptionCard";
import type { TopologySelection } from "@/components/topology/TopologyCanvas";
import { useI18n } from "@/components/i18n-provider";
import { WorkflowGraph } from "./WorkflowGraph";
import { ActionsIllustration } from "./ActionsIllustration";
import { workflowJobs, workflowJobOffset } from "./workflow-editor";
import { workflowEventConfig as object } from "./workflow-yaml";
import type { useWorkflowDraft } from "./useWorkflowDraft";

export function WorkflowWorkspace({
  plan,
  draft,
  selection,
  onSelect,
  onConnect,
  onAdd,
  loading,
  invalid,
  yamlRequest,
}: {
  plan: ActionPlanView | null;
  draft: ReturnType<typeof useWorkflowDraft>;
  selection: TopologySelection;
  onSelect: (selection: TopologySelection) => void;
  onConnect: (connection: Connection) => void;
  onAdd: () => void;
  loading: boolean;
  invalid: boolean;
  yamlRequest: { id: string; key: number } | null;
}) {
  const { t } = useI18n();
  const e = t.actions.editor;
  const [view, setView] = useState<"topology" | "list" | "yaml">("topology");
  const id = useId();
  const yaml = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (yamlRequest) setView("yaml");
  }, [yamlRequest]);
  useEffect(() => {
    if (view !== "yaml" || !yamlRequest || !yaml.current) return;
    try {
      const input = yaml.current;
      const offset = workflowJobOffset(input.value, yamlRequest.id);
      input.focus({ preventScroll: true });
      input.setSelectionRange(offset, offset);
      input.scrollTop = Math.max(0, (input.value.slice(0, offset).split("\n").length - 4) * 24);
    } catch {
      // diagnostics-ignore: A job removed or renamed in raw YAML has no current editor position.
    }
  }, [view, yamlRequest]);
  let jobs: ReturnType<typeof workflowJobs> = [];
  try {
    if (draft.source) jobs = workflowJobs(draft.source);
  } catch {
    // diagnostics-ignore: Incomplete draft YAML keeps its last valid graph and remains editable in the YAML view.
  }
  return (
    <section
      className="flex h-[440px] min-w-0 flex-col overflow-hidden rounded-2xl bg-card @min-[960px]:h-auto @min-[960px]:min-h-0"
      data-testid="workflow-workspace"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 pt-2">
        <Tabs
          tabs={[
            {
              key: "topology",
              label: e.topology,
              leading: (
                <Icon
                  name="topology"
                  className={`size-4 ${view === "topology" ? "text-success" : "text-muted-foreground"}`}
                />
              ),
            },
            { key: "list", label: e.list, icon: "list" },
            { key: "yaml", label: e.yaml, icon: "code" },
          ]}
          value={view}
          onChange={setView}
          idPrefix={id}
          ariaLabel={e.view}
          size="sm"
          className="border-0"
        />
        <div className="flex items-center gap-1 pb-1">
          <Button
            size="icon"
            variant="ghost"
            disabled={!draft.canUndo}
            onClick={draft.undo}
            aria-label={e.undo}
            title={e.undo}
          >
            <Icon name="arrow-left" className="rtl:rotate-180" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={!draft.canRedo}
            onClick={draft.redo}
            aria-label={e.redo}
            title={e.redo}
          >
            <Icon name="arrow-right" className="rtl:rotate-180" />
          </Button>
          <Button size="sm" variant="secondary" disabled={!jobs.length} onClick={onAdd}>
            <Icon name="plus" className="text-success" />
            {e.addJob}
          </Button>
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-${view}`}
        aria-labelledby={`${id}-tab-${view}`}
        className="relative min-h-0 flex-1"
      >
        {view === "yaml" ? (
          <textarea
            ref={yaml}
            aria-label={t.actions.source}
            dir="ltr"
            spellCheck={false}
            value={draft.source}
            onChange={(event) => draft.change(event.target.value)}
            className="absolute inset-0 h-full w-full resize-none bg-background/50 p-5 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        ) : plan ? (
          view === "topology" ? (
            <WorkflowGraph
              plan={plan}
              className="absolute inset-0 min-w-0 overflow-hidden"
              editor={{ selection, onSelect, onConnect }}
            />
          ) : (
            <div className="absolute inset-0 overflow-y-auto p-4">
              <div className="space-y-2">
                {plan.jobs.map((job) => {
                  const value = jobs.find((item) => item.id === job.id)?.value;
                  const steps = Array.isArray(value?.steps) ? value.steps : [];
                  const selected = selection?.kind === "node" && selection.id === job.id;
                  return (
                    <button
                      key={job.id}
                      type="button"
                      aria-label={`${e.editJob}: ${job.name}`}
                      aria-pressed={selected}
                      onClick={() => onSelect({ kind: "node", id: job.id })}
                      className={`flex w-full items-start gap-3 rounded-xl border p-4 text-start transition-colors focus-visible:outline-2 focus-visible:outline-ring ${optionCardSurface(selected)}`}
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-success-bg text-success">
                        <Icon name="terminal" className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-sm font-medium">{job.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {e.steps} · {steps.length}
                          </span>
                        </span>
                        <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                          {typeof job.runsOn === "string"
                            ? job.runsOn
                            : Array.isArray(job.runsOn)
                              ? job.runsOn.join(" · ")
                              : "runs-on"}
                        </span>
                        {!!job.needs.length && (
                          <span className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Icon name="git-branch" className="size-3.5 shrink-0 text-info" />
                            {e.dependsOn}: {job.needs.join(", ")}
                          </span>
                        )}
                        {!!steps.length && (
                          <span className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            {steps.map((value, index) => {
                              const step = object(value);
                              return (
                                <span
                                  className="inline-flex max-w-full items-center gap-1.5"
                                  key={index}
                                >
                                  <Icon
                                    name={Object.hasOwn(step, "uses") ? "bolt" : "terminal"}
                                    className={`size-3.5 shrink-0 ${Object.hasOwn(step, "uses") ? "text-info" : "text-success"}`}
                                  />
                                  <span className="truncate">
                                    {index + 1}.{" "}
                                    {
                                      String(step.name || step.uses || step.run || "").split(
                                        "\n",
                                      )[0]
                                    }
                                  </span>
                                </span>
                              );
                            })}
                          </span>
                        )}
                      </span>
                      <Icon
                        name="chevron-right"
                        className="mt-2 size-4 shrink-0 text-muted-foreground rtl:rotate-180"
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          )
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
            <ActionsIllustration className="mb-5 h-40 w-64 max-w-full" />
            <p className="max-w-sm text-sm text-muted-foreground">
              {loading ? t.actions.integration.loading : t.actions.integration.previewHint}
            </p>
          </div>
        )}
      </div>
      <div
        className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground"
        role="status"
      >
        <Icon
          name={invalid ? "alert-circle" : "cursor"}
          className={`size-3.5 shrink-0 ${invalid ? "text-warning" : "text-info"}`}
        />
        <span>{invalid ? t.actions.integration.fixYaml : e.canvasHint}</span>
      </div>
    </section>
  );
}
