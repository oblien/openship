"use client";
import { Icon } from "@repo/ui/icons";
import { actionFinished } from "@repo/core";
import type { ActionRunView } from "@repo/contracts";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { actionsApi } from "@/lib/api/actions";
import { useActionResource } from "./useActions";
import { ActionError } from "./ActionStatus";
import Link from "next/link";

/** The current admission wins over an older approval timestamp after policy changes. */
export function runApprovalState(run: ActionRunView) {
  const pending = run.admission
    ? run.admission.state !== "allowed"
    : run.controller !== "github" && run.untrusted && !run.approvedAt;
  if (pending) {
    if (run.finishedAt || actionFinished(run.status) || run.cancelRequestedAt) return "closed";
    return run.admission?.state === "blocked" ? "blocked" : "required";
  }
  return run.admission?.state === "allowed" || run.approvedAt ? "allowed" : "none";
}

type RunApprovalProps = {
  run: ActionRunView;
  busy: boolean;
  onApprove: () => void;
};

export function RunApproval({ run, busy, onApprove }: RunApprovalProps) {
  const { t } = useI18n();
  const state = runApprovalState(run);
  if (state === "required" || state === "blocked") {
    if (run.admission) return <ApprovalReview run={run} busy={busy} onApprove={onApprove} />;
    return (
      <section className="space-y-4 rounded-2xl bg-card p-5" aria-label={t.actions.access.waiting}>
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Icon name="shield" className="size-4 text-warning" />
          {t.actions.access.waiting}
        </h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {t.actions.approvalHint}
        </p>
        {run.canApprove === true ? (
          <Button size="sm" disabled={busy} onClick={onApprove}>
            {t.actions.approve}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">{t.actions.access.reviewerRequired}</p>
        )}
      </section>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-card p-5 text-sm" role="status">
      <Icon
        name={state === "allowed" ? "check-circle" : "shield"}
        className={`size-5 shrink-0 ${state === "allowed" ? "text-success" : "text-muted-foreground"}`}
      />
      {state === "allowed"
        ? t.actions.access.reasons.allowed
        : state === "closed"
          ? t.actions.runView.approvalClosed
          : t.actions.runView.noApprovals}
    </div>
  );
}

function ApprovalReview({ run, busy, onApprove }: RunApprovalProps) {
  const { t } = useI18n();
  const c = t.actions.access;
  const runners = useActionResource(actionsApi.runners);
  const blocked = run.admission?.state === "blocked";
  const destinations = runners.data?.filter((runner) => run.runnerIds?.includes(runner.id)) ?? [];
  const loaded =
    !!runners.data && !!run.runnerIds?.length && destinations.length === run.runnerIds.length;
  const destinationError =
    runners.error ?? (runners.data && !loaded ? c.destinationsUnavailable : null);
  return (
    <section
      className="space-y-4 rounded-2xl bg-card p-5"
      aria-label={blocked ? c.blocked : c.waiting}
    >
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Icon name="shield" className="size-4 text-warning" />
        {blocked ? c.blocked : c.waiting}
      </h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {blocked
          ? (c.reasons[run.admission!.reason as keyof typeof c.reasons] ?? c.blocked)
          : interpolate(c.reviewHint, {
              commit: run.revision.slice(0, 12),
              attempt: String(run.attempt),
              actor:
                run.triggeringActor && run.triggeringActor !== run.actor
                  ? `${run.actor} / ${run.triggeringActor}`
                  : run.actor,
            })}
      </p>
      <ActionError message={destinationError} onRetry={runners.refresh} />
      {runners.loading && !runners.data && (
        <div className="h-9 animate-pulse rounded-lg bg-background" aria-busy="true" />
      )}
      {!!destinations.length && (
        <div className="flex flex-wrap gap-2" aria-label={c.destinations}>
          {destinations.map((runner) => (
            <span
              key={runner.id}
              className="flex items-center gap-2 rounded-lg bg-background px-3 py-2 text-xs"
            >
              <Icon
                name={runner.kind === "cloud" ? "cloud" : "server"}
                className="size-3.5 text-muted-foreground"
              />
              {runner.name}
            </span>
          ))}
        </div>
      )}
      {destinations.some((runner) => runner.kind === "cloud") && (
        <p className="text-xs text-muted-foreground">{c.budget}</p>
      )}
      {blocked ? (
        <Button asChild size="sm" variant="secondary">
          <Link href={`/actions/workflows/${run.workflowId}`}>{c.settings}</Link>
        </Button>
      ) : run.canApprove === true ? (
        <Button size="sm" disabled={busy || !loaded || !!destinationError} onClick={onApprove}>
          {c.approve}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">{c.reviewerRequired}</p>
      )}
    </section>
  );
}
