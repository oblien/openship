"use client";

/**
 * The prominent "pick up where you left off" action for an incomplete mail
 * install. Rendered at the TOP of the progress view so resuming — not the
 * quieter Reset (start-over) in the log header — is the obvious next step when
 * an operator reopens a server that halted mid-setup.
 *
 * Presentational: the caller (mail-console) owns which step to resume from
 * (`stepId`), the step's human label, and the halt reason (`error`).
 */

import { PauseCircle, PlayCircle } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface ResumeHeroProps {
  stepId: number;
  stepLabel?: string | null;
  error?: string | null;
  onResume: (step: number) => void;
}

export function ResumeHero({ stepId, stepLabel, error, onResume }: ResumeHeroProps) {
  const { t } = useI18n();
  return (
    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <PauseCircle className="size-5 shrink-0 text-primary" />
            <h3 className="text-base font-semibold text-foreground">
              {t.emails.progress.resumePausedTitle}
            </h3>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {interpolate(t.emails.progress.stepLabel, { step: String(stepId) })}
            </span>
            {stepLabel ? `: ${stepLabel}` : null}
          </p>
          {error && <p className="mt-1 break-words text-xs text-danger">{error}</p>}
        </div>
        <button
          type="button"
          onClick={() => onResume(stepId)}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <PlayCircle className="size-4" />
          {interpolate(t.emails.progress.continueFromStep, { step: String(stepId) })}
        </button>
      </div>
    </div>
  );
}
