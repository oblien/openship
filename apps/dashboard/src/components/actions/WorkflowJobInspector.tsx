"use client";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import type { TopologySelection } from "@/components/topology/TopologyCanvas";
import { useI18n } from "@/components/i18n-provider";
import { WorkflowJobEditor } from "./WorkflowJobEditor";
import type { WorkflowExpandedSteps, WorkflowStepTarget } from "./WorkflowSteps";
import { editWorkflowDependency, workflowJobs } from "./workflow-editor";

type Edit = (operation: () => string) => void;

export function WorkflowJobInspector({
  source,
  selection,
  edit,
  onClose,
  onEditYaml,
  expandedSteps,
  onExpandedStepsChange,
  stepToReveal,
}: {
  source: string;
  selection: NonNullable<TopologySelection>;
  edit: Edit;
  onClose: () => void;
  onEditYaml: (id: string) => void;
  expandedSteps: WorkflowExpandedSteps;
  onExpandedStepsChange: (expanded: WorkflowExpandedSteps) => void;
  stepToReveal: WorkflowStepTarget | null;
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
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Icon name="git-branch" className="size-5" />
          </span>
          {e.connection}
        </h2>
        <div className="space-y-3 rounded-xl bg-background p-4 text-sm">
          <p className="break-words font-medium">
            {(jobs.find((job) => job.id === from)?.value.name as string) || from}
          </p>
          <Icon name="arrow-down" className="size-4 text-muted-foreground" />
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
  return (
    <div className="space-y-3" data-testid="workflow-job-inspector">
      <InspectorBack onClose={onClose} />
      <WorkflowJobEditor
        key={job.id}
        source={source}
        job={job}
        jobs={jobs}
        edit={edit}
        expandedSteps={expandedSteps}
        onExpandedStepsChange={onExpandedStepsChange}
        stepToReveal={stepToReveal}
        onEditYaml={onEditYaml}
      />
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
