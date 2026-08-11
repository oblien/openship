"use client";

/**
 * Live-progress view for /emails - logs only.
 *
 * "Where am I in the plan" lives in the right sidebar (`MailSidebar` →
 * `All steps`), which auto-scrolls to the current step. This column is
 * dedicated to the log stream so we don't render the same step list twice.
 */

import { useEffect, useRef, useState } from "react";
import { XCircle, RotateCcw, ArrowDown, Trash2 } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface LogEntry {
  stepId: number;
  level: string;
  message: string;
}

interface MailProgressProps {
  logs: LogEntry[];
  running: boolean;
  error: string | null;
  resumeStep: number | null;
  /** Whether the Reset button can be shown (requires a selected server). */
  canReset: boolean;
  onCancel: () => void;
  onResume: (fromStep: number) => void;
  onReset: () => void;
}

/**
 * Pixels from the bottom within which we still consider the scroll position
 * "at bottom". Generous on purpose - browser scrollbar widths, subpixel
 * rendering, and the panel's inner padding can all leave the user 30–60 px
 * above the technical bottom while they feel like they're already there.
 */
const STICK_TO_BOTTOM_THRESHOLD = 80;

export function MailProgress({
  logs,
  running,
  error,
  resumeStep,
  canReset,
  onCancel,
  onResume,
  onReset,
}: MailProgressProps) {
  const { t } = useI18n();
  // Auto-scroll-to-tail behavior is opt-in based on user position: if the
  // user scrolls up from the bottom we STOP yanking them back. They can
  // click the "Jump to latest" button (or scroll back themselves) to re-arm.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  // Two-click confirm for Reset (destructive). First click flips to a
  // "Confirm?" affordance; auto-revert after a few seconds if the user
  // doesn't follow through. Better than a modal dialog for this density.
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const t = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(t);
  }, [confirmReset]);

  const handleResetClick = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    onReset();
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // If content doesn't overflow the viewport there's no "below the bottom"
    // - treat as at-bottom by definition. Otherwise check distance against
    // the threshold.
    const overflow = el.scrollHeight - el.clientHeight;
    if (overflow <= 0) {
      setStickToBottom(true);
      return;
    }
    const distance = overflow - el.scrollTop;
    setStickToBottom(distance < STICK_TO_BOTTOM_THRESHOLD);
  };

  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, stickToBottom]);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
  };
  return (
    <div className="space-y-4 min-w-0">
      {/* Logs panel - dominant element on this side. `relative` anchors
          the floating "Jump to latest" pill below. */}
      <div className="relative bg-card rounded-2xl border border-border/50 overflow-hidden">
        <div className="px-5 py-3 border-b border-border/50 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="text-sm font-medium text-foreground">{t.emails.progress.liveLogs}</h3>
            <span className="text-xs text-muted-foreground/70 tabular-nums">
              {interpolate(
                logs.length === 1 ? t.emails.progress.lineOne : t.emails.progress.lineOther,
                { count: String(logs.length) },
              )}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {running ? (
              <button
                onClick={onCancel}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-danger-border text-danger hover:bg-danger-bg transition-colors"
              >
                <XCircle className="size-3.5" />
                {t.emails.progress.cancel}
              </button>
            ) : (
              canReset && (
                <button
                  onClick={handleResetClick}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    confirmReset
                      ? "bg-danger-solid text-white hover:bg-danger-solid/90"
                      : "border border-danger-border text-danger hover:bg-danger-bg"
                  }`}
                  title={t.emails.progress.resetTitle}
                >
                  <Trash2 className="size-3.5" />
                  {confirmReset ? t.emails.progress.confirmReset : t.emails.progress.reset}
                </button>
              )
            )}
          </div>
        </div>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-[min(48vh,560px)] overflow-y-auto p-4 bg-muted/20"
        >
          {logs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-xs text-muted-foreground/60">
              {running
                ? t.emails.progress.waiting
                : error
                  ? t.emails.progress.noBuffered
                  : t.emails.progress.willStream}
            </div>
          ) : (
            <div className="space-y-0.5 font-mono text-xs">
              {logs.map((log, i) => (
                <div
                  key={i}
                  className={`flex gap-2 ${
                    log.level === "error"
                      ? "text-danger"
                      : log.level === "warn"
                        ? "text-warning"
                        : "text-muted-foreground"
                  }`}
                >
                  <span className="text-muted-foreground/40 shrink-0 select-none">
                    [{String(log.stepId).padStart(2, " ")}]
                  </span>
                  <span className="break-all whitespace-pre-wrap">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* "Jump to latest" pill - only renders when the user has scrolled
            away from the tail. Absolutely positioned over the panel so the
            scroll container's flow and padding don't fight us. */}
        {!stickToBottom && logs.length > 0 && (
          <button
            onClick={jumpToLatest}
            className="absolute left-1/2 -translate-x-1/2 bottom-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full bg-foreground text-background shadow-lg hover:bg-foreground/90 transition-colors"
          >
            <ArrowDown className="size-3.5" />
            {t.emails.progress.jumpToLatest}
          </button>
        )}
      </div>

      {/* Error banner - retry CTA is mirrored here so it's hard to miss
          even when the user's eye is on the logs. */}
      {error && (
        <div className="bg-danger-bg border border-danger-border rounded-2xl p-5">
          <div className="flex items-start gap-3">
            <XCircle className="size-5 text-danger mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-danger">
                {t.emails.progress.setupFailed}
              </p>
              <p className="text-xs text-muted-foreground mt-1 break-words">{error}</p>
              {resumeStep && (
                <button
                  onClick={() => onResume(resumeStep)}
                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <RotateCcw className="size-3.5" />
                  {interpolate(t.emails.progress.retryFromStep, { resumeStep: String(resumeStep) })}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
