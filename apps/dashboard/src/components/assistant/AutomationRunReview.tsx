"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AUTOMATION_ACTIONS, type AssistantAutomationRun } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useScopedMutation, useScopedResource } from "@/hooks/use-scoped-resource";
import { assistantAutomationsApi } from "@/lib/api/assistant-automations";
import { Button } from "@/components/ui/button";
import { AssistantDialog } from "./AssistantDialog";

const outcomes: Record<AssistantAutomationRun["state"], string> = {
  queued: "Queued",
  investigating: "Investigating",
  approval: "Needs approval",
  applying: "Applying",
  verifying: "Verifying health",
  reported: "Findings ready",
  succeeded: "Completed",
  failed: "Needs attention",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

export function AutomationRunBadge({ run }: { run: AssistantAutomationRun }) {
  const label =
    run.state === "succeeded" && ["restart", "redeploy"].includes(run.action)
      ? "Healthy"
      : outcomes[run.state];
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs ${run.state === "succeeded" ? "bg-success/10 text-success" : ["approval", "failed"].includes(run.state) ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground"}`}
    >
      {label}
    </span>
  );
}

export function AutomationResultLink({ run }: { run: AssistantAutomationRun }) {
  if (!run.resultUrl?.startsWith("https://github.com/")) return null;
  return (
    <a
      href={run.resultUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 text-sm text-foreground underline underline-offset-4"
    >
      {run.action === "pull_request" ? "View pull request" : "View commit"}
      <Icon name="arrow-up-right" className="size-4" />
    </a>
  );
}

/** The same persisted proposal is reviewed from the run list and its agent conversation. */
export function AutomationRunReview({
  run,
  onClose,
  onDecided,
}: {
  run: AssistantAutomationRun;
  onClose(): void;
  onDecided(): void;
}) {
  const fetcher = useCallback(() => assistantAutomationsApi.proposal(run.id), [run.id]);
  const proposal = useScopedResource(fetcher);
  const mutation = useScopedMutation();
  const patch = proposal.data && "patch" in proposal.data ? proposal.data.patch : null;
  const label = AUTOMATION_ACTIONS.find((a) => a.id === run.action)?.label ?? "Proposed action";
  const decide = async (decision: "approve" | "cancel") => {
    const result = await mutation.execute(() => assistantAutomationsApi.decide(run.id, decision));
    if (result) {
      onDecided();
      onClose();
    }
  };
  return (
    <AssistantDialog
      isOpen
      label="Review automation action"
      onClose={onClose}
      closable={!mutation.busy}
      width={patch ? "900px" : "560px"}
      maxWidth="calc(100vw - 24px)"
      maxHeight="calc(100dvh - 24px)"
      overflow="auto"
    >
      <div className="space-y-5 p-6 sm:p-8">
        <span className="inline-flex rounded-xl bg-info-bg p-3 text-info">
          <Icon name="shield-check" className="size-6" />
        </span>
        <div>
          <h2 className="text-xl font-medium">{label}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{run.projectName}</p>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          {run.action === "restart"
            ? "This restarts the active deployment’s containers and can interrupt running services."
            : run.action === "redeploy"
              ? "This rebuilds the current commit through the normal deployment pipeline. Services can be interrupted during cutover."
              : "Review every changed file below. OpenShip publishes this exact patch in one commit on a new branch. Repository CI may run when the branch or draft PR is created."}
        </p>
        {proposal.loading && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading the saved proposal…
          </p>
        )}
        {proposal.error && (
          <p role="alert" className="text-sm text-danger">
            {proposal.error}
          </p>
        )}
        {patch && (
          <div className="space-y-4">
            <div className="rounded-xl bg-card p-4">
              <h3 className="text-sm font-medium">{patch.title}</h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {patch.description}
              </p>
              <p className="mt-3 break-all text-xs text-muted-foreground">
                Based on {patch.baseBranch} · {patch.baseSha}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              {patch.files.length} changed {patch.files.length === 1 ? "file" : "files"} · Complete
              proposed contents
            </p>
            {patch.files.map((file) => (
              <details key={file.path} className="rounded-xl bg-card p-4">
                <summary className="cursor-pointer break-all text-sm font-medium">
                  {file.path}
                </summary>
                <pre className="mt-4 max-h-80 overflow-auto rounded-lg bg-background p-4 text-xs leading-5">
                  <code>{file.content}</code>
                </pre>
              </details>
            ))}
            <p className="text-xs leading-5 text-muted-foreground">
              Publishing a code fix does not deploy it or confirm app recovery. Review the PR and
              its checks before merging.
            </p>
          </div>
        )}
        {run.conversationId && (
          <Link
            className="inline-block text-sm underline underline-offset-4"
            href={`/assistant?chat=${encodeURIComponent(run.conversationId)}`}
            onClick={onClose}
          >
            Read the investigation
          </Link>
        )}
        <p className="text-xs text-muted-foreground">
          Approval expires {run.expiresAt ? new Date(run.expiresAt).toLocaleTimeString() : "soon"}.
          Permissions and the current incident are checked again before applying.
        </p>
        {mutation.error && (
          <p role="alert" className="text-sm text-danger">
            {mutation.error}
          </p>
        )}
      </div>
      <div className="sticky bottom-0 flex shrink-0 justify-end gap-2 bg-background p-5">
        <Button variant="ghost" disabled={mutation.busy} onClick={() => void decide("cancel")}>
          Decline
        </Button>
        <Button
          disabled={
            mutation.busy ||
            !proposal.data ||
            !!proposal.error ||
            proposal.data.action !== run.action
          }
          onClick={() => void decide("approve")}
        >
          {mutation.busy ? "Applying…" : "Approve action"}
          <Icon name="arrow-right" className="size-4" />
        </Button>
      </div>
    </AssistantDialog>
  );
}

export function AutomationConversationStatus({
  runId,
  onChatAvailability,
}: {
  runId: string;
  onChatAvailability?(value: { id: string; allowed: boolean }): void;
}) {
  const fetcher = useCallback(() => assistantAutomationsApi.run(runId), [runId]);
  const resource = useScopedResource(fetcher, 4000);
  const [review, setReview] = useState(false);
  const run = resource.data;
  useEffect(() => {
    onChatAvailability?.({
      id: runId,
      allowed:
        !!run &&
        ["investigating", "reported", "succeeded", "failed", "skipped", "cancelled"].includes(
          run.state,
        ),
    });
  }, [runId, run?.state, onChatAvailability]);
  return (
    <div className="shrink-0 space-y-3 rounded-2xl bg-card p-4 sm:p-5">
      {run && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Icon name="workflow" className="size-4 text-info" />
              <span className="text-sm font-medium">{run.name}</span>
            </div>
            <AutomationRunBadge run={run} />
          </div>
          <p className="text-sm leading-6 text-muted-foreground">{run.message}</p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <AutomationResultLink run={run} />
            {run.state === "approval" && (
              <Button size="sm" onClick={() => setReview(true)}>
                Review proposed action
                <Icon name="arrow-right" className="size-4" />
              </Button>
            )}
          </div>
          {review && (
            <AutomationRunReview
              run={run}
              onClose={() => setReview(false)}
              onDecided={resource.refresh}
            />
          )}
        </>
      )}
      {resource.loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Checking the automation…
        </p>
      )}
      {resource.error && (
        <p role="alert" className="text-sm text-danger">
          {resource.error}
        </p>
      )}
    </div>
  );
}
