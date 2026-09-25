import { Icon as UiIcon } from "@repo/ui/icons";
import { useEffect, useRef, useState } from "react";
import type { ComponentState, Step } from "./types";
import type { SetupComponentProgress, SetupLogEvent } from "@/lib/api/system";
import { ComponentRow } from "./component-row";
import { useI18n, interpolate } from "@/components/i18n-provider";

const SETUP_STEP_ICONS = ["wifi", "search", "download"] as const;

function ProgressRow({ component }: { component: SetupComponentProgress }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg">
      <div className="shrink-0">
        {component.status === "installing" ? (
          <UiIcon name="spinner" className="size-4 text-primary animate-spin" />
        ) : component.status === "installed" ? (
          <UiIcon name="check-circle" className="size-4 text-success" />
        ) : component.status === "failed" ? (
          <UiIcon name="x-circle" className="size-4 text-danger" />
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
              ? "bg-success-bg text-success"
              : component.status === "failed"
                ? "bg-danger-bg text-danger"
                : "bg-muted text-muted-foreground"
        }`}
      >
        {component.status === "installing"
          ? t.servers.setup.statusInstalling
          : component.status === "installed"
            ? t.servers.setup.statusDone
            : component.status === "failed"
              ? t.servers.setup.statusFailed
              : t.servers.setup.statusWaiting}
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
  const { t } = useI18n();
  const [logsOpen, setLogsOpen] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const SETUP_STEPS = [
    { label: t.servers.setup.stepConnect, Icon: SETUP_STEP_ICONS[0] },
    { label: t.servers.setup.stepCheck, Icon: SETUP_STEP_ICONS[1] },
    { label: t.servers.setup.stepInstall, Icon: SETUP_STEP_ICONS[2] },
  ];

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
          <div className="absolute top-6 start-[24px] end-[24px] h-[2px] bg-border/50">
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
                      <UiIcon name="x-circle" className="w-6 h-6 text-destructive-foreground" />
                    ) : isCompleted ? (
                      <UiIcon name="check" className="w-6 h-6 text-primary-foreground" />
                    ) : isCurrent ? (
                      <UiIcon name="spinner" className="w-6 h-6 text-background animate-spin" />
                    ) : (
                      <UiIcon name={Icon} className="w-5 h-5 text-muted-foreground" />
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
              <span className="text-muted-foreground font-medium">{t.servers.setup.overallProgress}</span>
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
            {interpolate(t.servers.setup.connectingChecking, { host: serverHost })}
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
                    ? "bg-success-bg"
                    : "bg-danger-bg"
                  : "bg-primary/10"
              }`}
            >
              {streamDone ? (
                streamFinalStatus === "completed" ? (
                  <UiIcon name="check-circle" className="size-[18px] text-success" />
                ) : (
                  <UiIcon name="x-circle" className="size-[18px] text-danger" />
                )
              ) : (
                <UiIcon name="download" className="size-[18px] text-primary" />
              )}
            </div>
            <div className="flex-1">
              <h2 className="font-semibold text-foreground text-[15px]">
                {streamDone
                  ? streamFinalStatus === "completed"
                    ? t.servers.setup.allComponentsInstalled
                    : t.servers.setup.setupFinishedErrors
                  : t.servers.setup.installingComponents}
              </h2>
              <p className="text-xs text-muted-foreground">
                {streamDone
                  ? interpolate(t.servers.setup.installedOf, {
                      count: String(installed),
                      total: String(total),
                      host: serverHost,
                    })
                  : interpolate(t.servers.setup.settingUp, { host: serverHost })}
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
            <div className="w-9 h-9 bg-success-bg rounded-xl flex items-center justify-center">
              <UiIcon name="check-circle" className="size-[18px] text-success" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground text-[15px]">{t.servers.setup.allRequirementsMetTitle}</h2>
              <p className="text-xs text-muted-foreground">{interpolate(t.servers.setup.readyToDeploy, { host: serverHost })}</p>
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
            className="flex items-center gap-2 w-full px-5 py-3 text-start hover:bg-muted/30 transition-colors rounded-2xl"
          >
            {logsOpen ? (
              <UiIcon name="chevron-down" className="size-4 text-muted-foreground" />
            ) : (
              <UiIcon name="chevron-right" className="size-4 text-muted-foreground rtl:rotate-180" />
            )}
            <span className="text-sm font-medium text-foreground">{t.servers.setup.installLogs}</span>
            <span className="text-xs text-muted-foreground">
              ({streamLogs.length} {streamLogs.length === 1 ? t.servers.setup.line : t.servers.setup.lines})
            </span>
          </button>

          {logsOpen && (
            <div className="border-t border-border/50">
              <div className="max-h-[400px] overflow-y-auto p-4 bg-muted/20 rounded-b-2xl">
                {streamLogs.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">
                    {t.servers.setup.waitingForOutput}
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
                              ? "text-danger"
                              : entry.level === "warn"
                                ? "text-warning"
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
            <UiIcon name="check-circle" className="size-4" />
            {done ? t.servers.setup.doneGoToServers : t.servers.setup.goToServers}
          </button>
          {failed && failedCount > 0 && (
            <button
              onClick={onRetry}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
            >
              <UiIcon name="x-circle" className="size-4" />
              {interpolate(t.servers.setup.retryFailed, { count: String(failedCount) })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
