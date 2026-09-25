"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { useDeployment } from "@/context/DeploymentContext";
import { useI18n } from "@/components/i18n-provider";

/** One compact progress track with the current phase underneath. */
export function DeploymentStepper() {
  const { steps, state, deploymentStatus } = useDeployment();
  const { t } = useI18n();
  const copy = t.importProject.deploymentProcessing;
  const finished = ["ready", "failed", "cancelled"].includes(deploymentStatus);
  const currentIndex = deploymentStatus === "ready"
    ? steps.length - 1
    : Math.min(Math.max(state.currentStepIndex, 0), steps.length - 1);

  return (
    <div className="rounded-2xl bg-card p-5">
      <ol aria-label={copy.title.deploying} className="grid grid-flow-col auto-cols-fr gap-2">
        {steps.map((step, index) => {
          const atCurrent = index === state.currentStepIndex;
          const completed = deploymentStatus === "ready" || index < state.currentStepIndex;
          const active = atCurrent && !finished;
          const failed = atCurrent && deploymentStatus === "failed";
          const cancelled = atCurrent && deploymentStatus === "cancelled";
          const tone = completed
            ? "bg-primary text-primary-foreground"
            : failed
              ? "bg-destructive text-destructive-foreground"
              : active
                ? "bg-foreground text-background"
                : "border border-border bg-[var(--th-card-on-page)] text-muted-foreground";
          const statusLabel = completed
            ? copy.status.ready
            : failed
              ? copy.status.failed
              : cancelled
                ? copy.status.cancelled
                : active
                  ? copy.title.deploying
                  : t.importProject.serviceStatus.pending;

          return (
            <li
              key={index}
              aria-current={active || failed || cancelled ? "step" : undefined}
              aria-label={`${step.label}: ${statusLabel}`}
              title={`${step.label}: ${statusLabel}`}
              className="relative flex min-w-0 items-center justify-center"
            >
              {index < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`absolute start-1/2 top-4 h-0.5 w-[calc(100%+0.5rem)] ${completed ? "bg-primary" : "bg-border/70"}`}
                />
              )}
              {/* An opaque ring cuts the track away from the icon in every theme. */}
              <span
                aria-hidden="true"
                className={`relative z-10 inline-flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-[var(--th-card-on-page)] ${tone}`}
              >
                {completed ? (
                  <UiIcon name="check" className="size-5" />
                ) : failed ? (
                  <UiIcon name="close" className="size-5" />
                ) : cancelled ? (
                  <UiIcon name="minus" className="size-5" />
                ) : active ? (
                  <UiIcon name="spinner" className="size-5 motion-safe:animate-spin" />
                ) : (
                  <UiIcon name={step.icon} className="size-4.5" />
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {steps[currentIndex] && (
        <p aria-hidden="true" className="mt-3 flex items-center justify-between gap-3 text-sm">
          <span className={deploymentStatus === "failed" ? "text-danger" : "text-foreground"}>
            {steps[currentIndex].label}
          </span>
          <span dir="ltr" className="text-muted-foreground tabular-nums">{currentIndex + 1} / {steps.length}</span>
        </p>
      )}
    </div>
  );
}
