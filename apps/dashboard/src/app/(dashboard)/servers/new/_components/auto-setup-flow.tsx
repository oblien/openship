import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Search,
  Wifi,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComponentState, Step } from "./types";
import type { SetupComponentProgress, SetupLogEvent } from "@/lib/api/system";
import { ComponentRow } from "./component-row";

const SETUP_STEPS = [
  { label: "Connect", Icon: Wifi },
  { label: "Check", Icon: Search },
  { label: "Install", Icon: Download },
];

function ProgressRow({ component }: { component: SetupComponentProgress }) {
  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg">
      <div className="shrink-0">
        {component.status === "installing" ? (
          <Loader2 className="size-4 text-primary animate-spin" />
        ) : component.status === "installed" ? (
          <CheckCircle2 className="size-4 text-emerald-500" />
        ) : component.status === "failed" ? (
          <XCircle className="size-4 text-red-500" />
        ) : (
          <div className="size-4 rounded-full border-2 border-border/50" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{component.label}</p>
      </div>
      <span
        className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          component.status === "installing"
            ? "bg-primary/10 text-primary"
            : component.status === "installed"
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : component.status === "failed"
                ? "bg-red-500/10 text-red-600 dark:text-red-400"
                : "bg-muted text-muted-foreground"
        }`}
      >
        {component.status === "installing"
          ? "Installing\u2026"
          : component.status === "installed"
            ? "Done"
            : component.status === "failed"
              ? "Failed"
              : "Waiting"}
      </span>
    </div>
  );
}

interface AutoSetupFlowProps {
  step: Step;
  components: ComponentState[];
  overallReady: boolean;
  serverHost: string;
  streamComponents: SetupComponentProgress[];
  streamLogs: SetupLogEvent[];
  streamDone: boolean;
  streamFinalStatus: "completed" | "failed" | null;
  onDone: () => void;
  onRetry: () => void;
}

export function AutoSetupFlow({
  step,
  components,
  overallReady,
  serverHost,
  streamComponents,
  streamLogs,
  streamDone,
  streamFinalStatus,
  onDone,
  onRetry,
}: AutoSetupFlowProps) {
  const [logsOpen, setLogsOpen] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logsOpen && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [streamLogs.length, logsOpen]);

  // ── Map page step to stepper index ────────────────────────────────────
  let stepIndex: number;
  let failed = false;
  let done = false;

  if (step === "checking") {
    stepIndex = 1; // Connect done, Check active
  } else if (step === "results") {
    stepIndex = 3; // All done (no install needed)
    done = true;
  } else if (step === "installing") {
    if (streamDone) {
      if (streamFinalStatus === "completed") {
        stepIndex = 3;
        done = true;
      } else {
        stepIndex = 2;
        failed = true;
      }
    } else {
      stepIndex = 2;
    }
  } else {
    stepIndex = 0;
  }

  // ── Install progress ──────────────────────────────────────────────────
  const installed = streamComponents.filter((c) => c.status === "installed").length;
  const failedCount = streamComponents.filter((c) => c.status === "failed").length;
  const total = streamComponents.length;
  const pct = total > 0 ? Math.round(((installed + failedCount) / total) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* ── Stepper card ───────────────────────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border/50 p-8 transition-all duration-300">
        <div className="relative">
          {/* Progress line */}
          <div className="absolute top-6 left-[24px] right-[24px] h-[2px] bg-border/50">
            <div
              className="h-full transition-all duration-500 bg-primary"
              style={{
                width: `${Math.min((stepIndex / (SETUP_STEPS.length - 1)) * 100, 100)}%`,
              }}
            />
          </div>

          {/* Step circles */}
          <div className="relative flex justify-between">
            {SETUP_STEPS.map((s, i) => {
              const isCompleted = i < stepIndex || done;
              const isCurrent = i === stepIndex && !done && !failed;
              const isFailed = failed && i === stepIndex;
              const { Icon } = s;

              return (
                <div key={i} className="flex flex-col items-center px-2">
                  <div
                    style={{ boxShadow: "0 0 0 8px var(--card)" }}
                    className={`rounded-full flex items-center justify-center w-12 h-12 transition-all duration-300 ${
                      isFailed
                        ? "bg-destructive"
                        : isCompleted
                          ? "bg-primary"
                          : isCurrent
                            ? "bg-foreground"
                            : "bg-card border-2 border-border"
                    }`}
                  >
                    {isFailed ? (
                      <XCircle className="w-6 h-6 text-destructive-foreground" />
                    ) : isCompleted ? (
                      <Check className="w-6 h-6 text-primary-foreground" />
                    ) : isCurrent ? (
                      <Loader2 className="w-6 h-6 text-background animate-spin" />
                    ) : (
                      <Icon className="w-5 h-5 text-muted-foreground" />
                    )}
                  </div>
                  <span
                    className={`text-sm font-normal mt-3 ${
                      isFailed || isCompleted || isCurrent ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {s.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Progress bar (visible during install) */}
        {step === "installing" && !streamDone && (
          <div className="mt-6">
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-muted-foreground font-medium">Overall Progress</span>
              <span className="font-bold text-foreground">{pct}%</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden bg-border/50">
              <div
                className="h-full transition-all duration-300 bg-primary"
                style={{ width: `${Math.max(pct, 2)}%` }}
              />
            </div>
          </div>
        )}

        {/* Connecting message */}
        {step === "checking" && (
          <p className="mt-6 text-sm text-muted-foreground text-center">
            Connecting to {serverHost} and checking requirements&#8230;
          </p>
        )}
      </div>

      {/* ── Component progress (install phase) ─────────────────────────── */}
      {step === "installing" && (
        <div className="bg-card rounded-2xl border border-border/50">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                streamDone
                  ? streamFinalStatus === "completed"
                    ? "bg-emerald-500/10"
                    : "bg-red-500/10"
                  : "bg-primary/10"
              }`}
            >
              {streamDone ? (
                streamFinalStatus === "completed" ? (
                  <CheckCircle2 className="size-[18px] text-emerald-500" />
                ) : (
                  <XCircle className="size-[18px] text-red-500" />
                )
              ) : (
                <Download className="size-[18px] text-primary" />
              )}
            </div>
            <div className="flex-1">
              <h2 className="font-semibold text-foreground text-[15px]">
                {streamDone
                  ? streamFinalStatus === "completed"
                    ? "All Components Installed"
                    : "Setup Finished with Errors"
                  : "Installing Components"}
              </h2>
              <p className="text-xs text-muted-foreground">
                {streamDone
                  ? `${installed} of ${total} installed on ${serverHost}`
                  : `Setting up ${serverHost}\u2026`}
              </p>
            </div>
            {!streamDone && (
              <span className="text-xs font-medium text-muted-foreground">
                {installed}/{total}
              </span>
            )}
          </div>

          <div className="p-5 pt-3 space-y-0.5">
            {streamComponents.map((comp) => (
              <ProgressRow key={comp.name} component={comp} />
            ))}
          </div>
        </div>
      )}

      {/* ── All ready (nothing to install) ──────────────────────────────── */}
      {step === "results" && overallReady && (
        <div className="bg-card rounded-2xl border border-border/50">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
            <div className="w-9 h-9 bg-emerald-500/10 rounded-xl flex items-center justify-center">
              <CheckCircle2 className="size-[18px] text-emerald-500" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground text-[15px]">All Requirements Met</h2>
              <p className="text-xs text-muted-foreground">{serverHost} is ready to deploy</p>
            </div>
          </div>
          <div className="p-5 space-y-1">
            {components.map((comp) => (
              <ComponentRow key={comp.name} component={comp} />
            ))}
          </div>
        </div>
      )}

      {/* ── Install logs ───────────────────────────────────────────────── */}
      {step === "installing" && (
        <div className="bg-card rounded-2xl border border-border/50">
          <button
            onClick={() => setLogsOpen(!logsOpen)}
            className="flex items-center gap-2 w-full px-5 py-3 text-left hover:bg-muted/30 transition-colors rounded-2xl"
          >
            {logsOpen ? (
              <ChevronDown className="size-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )}
            <span className="text-sm font-medium text-foreground">Install Logs</span>
            <span className="text-xs text-muted-foreground">
              ({streamLogs.length} {streamLogs.length === 1 ? "line" : "lines"})
            </span>
          </button>

          {logsOpen && (
            <div className="border-t border-border/50">
              <div className="max-h-[400px] overflow-y-auto p-4 bg-muted/20 rounded-b-2xl">
                {streamLogs.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">
                    Waiting for output&#8230;
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {streamLogs.map((entry, i) => (
                      <div key={i} className="flex gap-2 text-xs font-mono leading-5">
                        <span className="text-muted-foreground/50 shrink-0 select-none">
                          {entry.component}
                        </span>
                        <span
                          className={
                            entry.level === "error"
                              ? "text-red-500"
                              : entry.level === "warn"
                                ? "text-yellow-500"
                                : "text-foreground/70"
                          }
                        >
                          {entry.message}
                        </span>
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Action buttons ─────────────────────────────────────────────── */}
      {(done || (failed && streamDone)) && (
        <div className="flex items-center gap-3">
          <button
            onClick={onDone}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all"
          >
            <CheckCircle2 className="size-4" />
            {done ? "Done \u2014 Go to Servers" : "Go to Servers"}
          </button>
          {failed && failedCount > 0 && (
            <button
              onClick={onRetry}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
            >
              <XCircle className="size-4" />
              Retry Failed ({failedCount})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
