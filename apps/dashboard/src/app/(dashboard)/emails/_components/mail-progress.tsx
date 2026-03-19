"use client";

import { type RefObject } from "react";
import {
  XCircle,
  RotateCcw,
  AlertTriangle,
} from "lucide-react";
import type { MailStepStatus } from "@/lib/api";
import { StepIcon } from "./step-icon";

interface LogEntry {
  stepId: number;
  level: string;
  message: string;
}

interface MailProgressProps {
  steps: MailStepStatus[];
  logs: LogEntry[];
  running: boolean;
  error: string | null;
  resumeStep: number | null;
  logsEndRef: RefObject<HTMLDivElement | null>;
  onCancel: () => void;
  onResume: (fromStep: number) => void;
}

export function MailProgress({
  steps,
  logs,
  running,
  error,
  resumeStep,
  logsEndRef,
  onCancel,
  onResume,
}: MailProgressProps) {
  return (
    <div className="space-y-6 min-w-0">
      {/* Steps progress */}
      <div className="bg-card rounded-2xl border border-border/50 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-medium text-foreground">Setup Progress</h2>
          <div className="flex items-center gap-2">
            {running && (
              <button
                onClick={onCancel}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors"
              >
                <XCircle className="size-3.5" />
                Cancel
              </button>
            )}
            {!running && error && resumeStep && (
              <button
                onClick={() => onResume(resumeStep)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <RotateCcw className="size-3.5" />
                Resume from Step {resumeStep}
              </button>
            )}
          </div>
        </div>

        <div className="space-y-1">
          {steps.map((step) => (
            <div
              key={step.id}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${
                step.status === "running"
                  ? "bg-blue-500/5 border border-blue-500/20"
                  : step.status === "failed"
                    ? "bg-red-500/5 border border-red-500/20"
                    : step.status === "completed"
                      ? "bg-emerald-500/5"
                      : ""
              }`}
            >
              <StepIcon status={step.status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-sm font-medium ${
                      step.status === "running"
                        ? "text-blue-600 dark:text-blue-400"
                        : step.status === "completed"
                          ? "text-foreground"
                          : step.status === "failed"
                            ? "text-red-600 dark:text-red-400"
                            : "text-muted-foreground/60"
                    }`}
                  >
                    {step.id}. {step.label}
                  </span>
                  {step.warning && (
                    <AlertTriangle className="size-3.5 text-amber-500" />
                  )}
                </div>
                {step.message && step.status !== "pending" && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {step.message}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Live logs */}
      {logs.length > 0 && (
        <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
          <div className="px-5 py-3 border-b border-border/50">
            <h3 className="text-sm font-medium text-foreground">Live Logs</h3>
          </div>
          <div className="max-h-[300px] overflow-y-auto p-4 bg-muted/30">
            <div className="space-y-1 font-mono text-xs">
              {logs.map((log, i) => (
                <div
                  key={i}
                  className={`flex gap-2 ${
                    log.level === "error"
                      ? "text-red-500"
                      : log.level === "warn"
                        ? "text-amber-500"
                        : "text-muted-foreground"
                  }`}
                >
                  <span className="text-muted-foreground/40 shrink-0">
                    [{log.stepId}]
                  </span>
                  <span className="break-all">{log.message}</span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="bg-red-500/5 border border-red-500/20 rounded-2xl p-5">
          <div className="flex items-start gap-3">
            <XCircle className="size-5 text-red-500 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-600 dark:text-red-400">
                Setup Failed
              </p>
              <p className="text-xs text-muted-foreground mt-1">{error}</p>
              {resumeStep && (
                <button
                  onClick={() => onResume(resumeStep)}
                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <RotateCcw className="size-3.5" />
                  Retry from Step {resumeStep}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
