"use client";

/**
 * The one place a mail-setup failure is rendered. Two callers, because a setup
 * can fail on either side of the progress stream:
 *
 *   - MailProgress — a step failed, or the install died mid-stream.
 *   - The setup form — the install never started at all (`POST /mail/setup`
 *     answered non-2xx). That case had NO render site before #492, so a broken
 *     host executor put the operator back on an empty form with no message.
 *
 * `onResume` is optional for exactly that reason: nothing was attempted, so
 * there is no step to retry from.
 */

import { XCircle, RotateCcw } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface SetupErrorBannerProps {
  title: string;
  message: string;
  resumeStep?: number | null;
  onResume?: (step: number) => void;
}

export function SetupErrorBanner({
  title,
  message,
  resumeStep,
  onResume,
}: SetupErrorBannerProps) {
  const { t } = useI18n();
  return (
    <div className="bg-danger-bg border border-danger-border rounded-2xl p-5">
      <div className="flex items-start gap-3">
        <XCircle className="size-5 text-danger mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-danger">{title}</p>
          <p className="text-xs text-muted-foreground mt-1 break-words">{message}</p>
          {resumeStep && onResume && (
            <button
              onClick={() => onResume(resumeStep)}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <RotateCcw className="size-3.5" />
              {interpolate(t.emails.progress.retryFromStep, {
                resumeStep: String(resumeStep),
              })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
