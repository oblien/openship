"use client";

import { useCallback, useId, useState } from "react";
import Link from "next/link";
import { Value } from "@sinclair/typebox/value";
import {
  AssistantAutomationActivationReviewSchema,
  AUTOMATION_ACTIONS,
  ASSISTANT_AUTOMATION_TRIGGERS,
  ASSISTANT_PROVIDER_LABELS,
  type AssistantAutomationActivationReview,
  type AssistantPart,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { useScopedMutation, useScopedResource } from "@/hooks/use-scoped-resource";
import { assistantAutomationsApi } from "@/lib/api/assistant-automations";
import { assistantToolName } from "./tool-presentation";
import { parseToolOutput } from "./tool-output";
import { AgentLink } from "./AgentLink";

/** Text, failed calls and unrelated tool payloads cannot create an activation control. */
export function automationActivationRequest(
  part: AssistantPart,
): AssistantAutomationActivationReview | null {
  const tool = part.type === "tool" ? part.tool : undefined;
  if (
    !tool ||
    tool.isError ||
    assistantToolName(tool) !== "post_assistant_automation_activation_review"
  )
    return null;
  const result = parseToolOutput(tool.output);
  return !result.isError && Value.Check(AssistantAutomationActivationReviewSchema, result.value)
    ? result.value
    : null;
}

export function automationActivationContinuation(result: AssistantAutomationActivationReview) {
  return `I reviewed these saved automations, which are now enabled: ${JSON.stringify(result.automations.map(({ id, name, revision }) => ({ id, name, revision })))}. ${result.paused ? "All automations are still globally paused; this approval did not resume them. " : ""}Verify their current state and continue the remaining work from my request. This approval applies only to the reviewed flows and their existing permissions.`;
}

type Props = {
  request: AssistantAutomationActivationReview;
  disabled?: boolean;
  onContinue?(message: string): Promise<boolean>;
};

export function AssistantAutomationActivation({ request, disabled, onContinue }: Props) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <section className="min-w-0 rounded-2xl bg-card" aria-label="Review automation activation">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-info-bg text-info">
          <Icon name="workflow" className="size-4" />
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <p className="text-sm font-medium">
            Enable{" "}
            {request.automations.length === 1
              ? "automation"
              : `${request.automations.length} automations`}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {request.automations.map((flow) => flow.name).join(" · ")}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide review" : "Review & enable"}
          <Icon name={open ? "chevron-up" : "chevron-down"} className="size-3.5" />
        </Button>
      </div>
      <div id={contentId} hidden={!open}>
        {open && <ActivationReview request={request} disabled={disabled} onContinue={onContinue} />}
      </div>
    </section>
  );
}

function ActivationReview({ request, disabled, onContinue }: Props) {
  const ids = JSON.stringify(request.automations.map((flow) => flow.id));
  const fetchReview = useCallback(
    () => assistantAutomationsApi.reviewActivation(JSON.parse(ids)),
    [ids],
  );
  const current = useScopedResource(fetchReview);
  const mutation = useScopedMutation();
  const [consent, setConsent] = useState(false);
  const [enabled, setEnabled] = useState<AssistantAutomationActivationReview | null>(null);
  const [continued, setContinued] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [continuationError, setContinuationError] = useState(false);
  const review = enabled ?? current.data;
  const sameWorkspace = review?.organizationId === request.organizationId;
  const pending = review?.automations.filter((flow) => !flow.enabled) ?? [];
  const automatic = pending.some((flow) => flow.mode === "automatic");
  const refresh = () => {
    setConsent(false);
    setEnabled(null);
    mutation.setError(null);
    current.refresh();
  };
  const approve = async () => {
    if (
      !review ||
      !sameWorkspace ||
      disabled ||
      continuing ||
      current.error ||
      current.loading ||
      (automatic && !consent)
    )
      return;
    const result = await mutation.execute(async () => {
      const saved = pending.length
        ? await assistantAutomationsApi.activate({
            automations: pending.map(({ id, revision }) => ({ id, revision })),
            automaticConsent: automatic && consent,
          })
        : review;
      return saved;
    });
    if (!result) return;
    setEnabled(result);
    if (onContinue) {
      setContinuing(true);
      const sent = await onContinue(
        automationActivationContinuation(result),
      ).catch(() => {
        /* diagnostics-ignore: Continue failure is shown inline with an explicit retry. */ return false;
      });
      setContinuing(false);
      setContinued(sent);
      setContinuationError(!sent);
    }
  };
  return (
    <div className="space-y-4 border-t border-border/50 p-4 sm:p-5">
      {current.loading && !enabled && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading the saved flows…
        </p>
      )}
      {review && !sameWorkspace && (
        <p role="alert" className="text-sm text-danger">
          Return to the workspace where these flows were requested to review them.
        </p>
      )}
      {review && sameWorkspace && (
        <>
          <p className="text-sm leading-6 text-muted-foreground">
            {continued
              ? "Enabled. Your assistant is continuing the task."
              : pending.length
                ? "These flows will start on future incidents. Review what each one can do."
                : "These flows are enabled. Continue the conversation to verify their status."}
          </p>
          <div className="divide-y divide-border/50">
            {review.automations.map((flow) => (
              <article key={flow.id} className="space-y-2 py-3 first:pt-0" aria-label={flow.name}>
                <div className="flex items-start gap-3">
                  <Icon
                    name={flow.trigger === "deployment.failed" ? "rocket" : "activity"}
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium">{flow.name}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {flow.projectName} ·{" "}
                      {
                        ASSISTANT_AUTOMATION_TRIGGERS.find((trigger) => trigger.id === flow.trigger)
                          ?.label
                      }
                    </p>
                  </div>
                  {flow.enabled && (
                    <Icon name="check" className="size-4 shrink-0" aria-label="Enabled" />
                  )}
                  <Link
                    href={`/assistant/automations/${encodeURIComponent(flow.id)}/edit`}
                    className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Edit flow
                  </Link>
                </div>
                <div className="ps-7 text-xs leading-5">
                  <p>
                    {flow.mode === "report"
                      ? "Investigate and report · No automatic changes"
                      : flow.mode === "approve"
                        ? "Investigate and propose · Each fix needs your approval"
                        : "Investigate and apply the allowed fixes automatically"}
                  </p>
                  {!!flow.allowedActions?.length && (
                    <p className="mt-1 text-muted-foreground">
                      {flow.allowedActions
                        .map(
                          (action) => AUTOMATION_ACTIONS.find((item) => item.id === action)?.label,
                        )
                        .join(" · ")}
                    </p>
                  )}
                  <p className="mt-1 text-muted-foreground">
                    Up to {flow.dailyLimit} runs/day · {flow.cooldownMinutes} min apart · Agent chat
                    {flow.channelIds.length
                      ? ` + ${flow.channelIds.length} notification channel${flow.channelIds.length === 1 ? "" : "s"}`
                      : ""}
                  </p>
                  <details className="mt-2 text-muted-foreground">
                    <summary className="cursor-pointer">Agent & instructions</summary>
                    <p className="mt-2">
                      {ASSISTANT_PROVIDER_LABELS[flow.provider]} · {flow.model || "Default model"}
                      {flow.readRepository ? " · Repository read access" : ""}
                    </p>
                    {flow.agentId && (
                      <AgentLink
                        href={`/assistant/agents/${encodeURIComponent(flow.agentId)}`}
                        className="underline underline-offset-4"
                      >
                        View assigned agent & access
                      </AgentLink>
                    )}
                    <p className="mt-1 whitespace-pre-wrap break-words">
                      {flow.instructions || "Use the agent’s existing investigation instructions."}
                    </p>
                  </details>
                </div>
              </article>
            ))}
          </div>
          {review.paused && (
            <p className="text-xs leading-5 text-warning">
              All automations are paused. Enabling these flows does not resume the others.{" "}
              <Link href="/assistant/automations" className="underline">
                Manage pause
              </Link>
            </p>
          )}
          {automatic && (
            <label className="flex items-center gap-3 text-sm">
              <Checkbox
                checked={consent}
                onCheckedChange={setConsent}
                disabled={mutation.busy || disabled}
              />
              Allow the listed automatic fixes for these apps
            </label>
          )}
        </>
      )}
      {(current.error || mutation.error) && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-danger">
            {mutation.error ?? current.error}
          </p>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={mutation.busy}>
            Refresh review
          </Button>
        </div>
      )}
      {continuationError && (
        <p role="alert" className="text-sm text-warning">
          The flows are enabled. The assistant could not continue yet; try Continue when it is
          ready.
        </p>
      )}
      {review && sameWorkspace && !continued && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            onClick={() => void approve()}
            disabled={
              disabled ||
              mutation.busy ||
              continuing ||
              current.loading ||
              !!current.error ||
              !!mutation.error ||
              (automatic && !consent)
            }
          >
            {continuing
              ? "Continuing…"
              : mutation.busy
                ? "Enabling…"
                : pending.length
                  ? onContinue
                    ? "Enable & continue"
                    : "Enable automations"
                  : "Continue"}
            <Icon name="arrow-right" className="size-4" />
          </Button>
          <p className="text-xs text-muted-foreground">
            {disabled
              ? "Available when the current turn finishes."
              : "Uses existing access. No permissions are added."}
          </p>
        </div>
      )}
    </div>
  );
}
