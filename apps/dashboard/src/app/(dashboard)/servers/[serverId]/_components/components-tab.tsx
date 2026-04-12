import {
  Shield,
  CheckCircle2,
  XCircle,
  Loader2,
  Download,
  RotateCcw,
  ChevronDown,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import type {
  ComponentStatus,
  SetupComponentProgress,
  SetupLogEvent,
} from "@/lib/api/system";

function HealthRow({
  component,
  busy,
  running,
  onRunAction,
  onRemoveAction,
}: {
  component: ComponentStatus;
  busy: boolean;
  running: boolean;
  onRunAction: (component: ComponentStatus) => void;
  onRemoveAction: (component: ComponentStatus) => void;
}) {
  const canRunAction = component.installable;
  const actionLabel = component.healthy || component.installed ? "Reinstall" : "Install";
  const canRemove = component.removable && component.installed;
  const removeDisabled = busy || component.removeSupported === false;

  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-muted/30 transition-colors">
      <div className="shrink-0">
        {component.healthy ? (
          <CheckCircle2 className="size-5 text-emerald-500" />
        ) : (
          <XCircle className="size-5 text-orange-500" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">
            {component.label || component.name}
          </p>
          {component.version && (
            <span className="text-xs text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
              v{component.version}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {component.message}
        </p>
      </div>
      <div
        className={`text-xs font-medium px-2.5 py-1 rounded-full ${
          component.healthy
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "bg-orange-500/10 text-orange-600 dark:text-orange-400"
        }`}
      >
        {component.healthy ? "Healthy" : "Unhealthy"}
      </div>
      {(canRunAction || (component.removable && component.installed)) && (
        <div className="flex items-center gap-2 shrink-0">
          {canRunAction && (
            <button
              onClick={() => onRunAction(component)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border border-border/70 hover:bg-muted transition-colors text-muted-foreground disabled:opacity-50"
            >
              {running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : component.healthy || component.installed ? (
                <RotateCcw className="size-3.5" />
              ) : (
                <Download className="size-3.5" />
              )}
              {running ? "Running..." : actionLabel}
            </button>
          )}
          {canRemove && (
            <button
              onClick={() => onRemoveAction(component)}
              disabled={removeDisabled}
              title={component.removeBlockedReason}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border border-red-500/30 hover:bg-red-500/5 transition-colors text-red-600 dark:text-red-400 disabled:opacity-50"
            >
              {running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <XCircle className="size-3.5" />
              )}
              {running ? "Running..." : component.removeSupported === false ? "Unsupported" : "Remove"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ComponentsTab({
  components,
  checking,
  checkError,
  onRecheck,
  onInstallMissing,
  onRunComponentAction,
  onRemoveComponentAction,
  busy,
  activeActionComponent,
  installDone,
  installFinalStatus,
  installComponents: streamComponents,
  actionMode,
  installLogs,
  onDismissInstall,
}: {
  components: ComponentStatus[];
  checking: boolean;
  checkError: string | null;
  onRecheck: () => void;
  onInstallMissing: () => void;
  onRunComponentAction: (component: ComponentStatus) => void;
  onRemoveComponentAction: (component: ComponentStatus) => void;
  busy: boolean;
  activeActionComponent: string | null;
  installDone: boolean;
  installFinalStatus: "completed" | "failed" | null;
  installComponents: SetupComponentProgress[];
  actionMode: "install" | "remove";
  installLogs: SetupLogEvent[];
  onDismissInstall: () => void;
}) {
  const [logsExpanded, setLogsExpanded] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const requiredComponents = components.filter((c) => !c.optional);
  const infraComponents = components.filter((c) => c.optional);

  const unhealthyInstallableCount = components.filter(
    (c) => !c.healthy && c.installable,
  ).length;
  const completedCount = streamComponents.filter(
    (c) => c.status === "installed" || c.status === "removed" || c.status === "failed",
  ).length;
  const progressTitle = actionMode === "remove"
    ? installDone
      ? installFinalStatus === "completed"
        ? "Removal Complete"
        : "Removal Finished with Errors"
      : "Removing\u2026"
    : installDone
      ? installFinalStatus === "completed"
        ? "Install Complete"
        : "Install Finished with Errors"
      : "Installing\u2026";
  const progressLogsLabel = actionMode === "remove" ? "Removal Logs" : "Install Logs";

  useEffect(() => {
    if (logsExpanded && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [installLogs.length, logsExpanded]);

  return (
    <div className="space-y-6">
      {/* Health checks card */}
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
          <div className="w-9 h-9 bg-emerald-500/10 rounded-xl flex items-center justify-center">
            <Shield className="size-[18px] text-emerald-500" />
          </div>
          <div className="flex-1">
            <h2 className="font-semibold text-foreground text-[15px]">
              System Health
            </h2>
            <p className="text-xs text-muted-foreground">
              Required components &amp; services
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onInstallMissing}
              disabled={checking || busy || unhealthyInstallableCount === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg hover:bg-muted transition-colors text-muted-foreground disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              {busy
                ? actionMode === "remove" ? "Removing\u2026" : "Installing\u2026"
                : unhealthyInstallableCount > 0
                  ? `Install Missing (${unhealthyInstallableCount})`
                  : "All installed"}
            </button>
            <button
              onClick={onRecheck}
              disabled={checking || busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg hover:bg-muted transition-colors text-muted-foreground disabled:opacity-50"
            >
              {checking ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              {checking ? "Checking\u2026" : "Re-check"}
            </button>
          </div>
        </div>

        <div className="p-5 space-y-0.5">
          {checkError && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 mb-3">
              <p className="text-xs text-red-600 dark:text-red-400">
                {checkError}
              </p>
            </div>
          )}

          {checking && components.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                  Running health checks\u2026
                </p>
              </div>
            </div>
          ) : requiredComponents.length > 0 || infraComponents.length > 0 ? (
            <>
              {requiredComponents.map((comp) => (
                <HealthRow
                  key={comp.name}
                  component={comp}
                  busy={busy}
                  running={activeActionComponent === comp.name}
                  onRunAction={onRunComponentAction}
                  onRemoveAction={onRemoveComponentAction}
                />
              ))}
              {infraComponents.length > 0 && (
                <>
                  <div className="flex items-center gap-2 pt-3 pb-1">
                    <div className="h-px flex-1 bg-border/50" />
                    <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
                      Detected Infrastructure
                    </span>
                    <div className="h-px flex-1 bg-border/50" />
                  </div>
                  {infraComponents.map((comp) => (
                    <HealthRow
                      key={comp.name}
                      component={comp}
                      busy={busy}
                      running={activeActionComponent === comp.name}
                      onRunAction={onRunComponentAction}
                      onRemoveAction={onRemoveComponentAction}
                    />
                  ))}
                </>
              )}
            </>
          ) : !checkError ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No health data yet
            </p>
          ) : null}
        </div>
      </div>

      {/* Install progress */}
      {(streamComponents.length > 0 || busy) && (
        <div className="bg-card rounded-2xl border border-border/50">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                installDone
                  ? installFinalStatus === "completed"
                    ? "bg-emerald-500/10"
                    : "bg-red-500/10"
                  : "bg-primary/10"
              }`}
            >
              {installDone ? (
                installFinalStatus === "completed" ? (
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
                {progressTitle}
              </h2>
              <p className="text-xs text-muted-foreground">
                {completedCount}
                /{streamComponents.length} components
              </p>
            </div>
            {installDone && (
              <button
                onClick={onDismissInstall}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Dismiss
              </button>
            )}
          </div>

          {/* Progress bar */}
          {streamComponents.length > 0 && (
            <div className="px-5 pt-4">
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    installDone && installFinalStatus === "failed"
                      ? "bg-red-500"
                      : "bg-primary"
                  }`}
                  style={{
                    width: `${
                      (streamComponents.filter(
                        (c) =>
                          c.status === "installed" || c.status === "removed" || c.status === "failed",
                      ).length /
                        streamComponents.length) *
                      100
                    }%`,
                  }}
                />
              </div>
            </div>
          )}

          {/* Component rows */}
          <div className="px-5 py-3 space-y-1">
            {streamComponents.map((comp) => (
              <div key={comp.name} className="flex items-center gap-2 py-1.5">
                <div className="shrink-0">
                  {comp.status === "installing" || comp.status === "removing" ? (
                    <Loader2 className="size-3.5 text-primary animate-spin" />
                  ) : comp.status === "installed" || comp.status === "removed" ? (
                    <CheckCircle2 className="size-3.5 text-emerald-500" />
                  ) : comp.status === "failed" ? (
                    <XCircle className="size-3.5 text-red-500" />
                  ) : (
                    <div className="size-3.5 rounded-full border-2 border-border/50" />
                  )}
                </div>
                <span className="text-sm font-medium text-foreground">
                  {comp.label}
                </span>
                <span
                  className={`ml-auto text-xs ${
                    comp.status === "installing" || comp.status === "removing"
                      ? "text-primary"
                      : comp.status === "installed" || comp.status === "removed"
                        ? "text-emerald-500"
                        : comp.status === "failed"
                          ? "text-red-500"
                          : "text-muted-foreground"
                  }`}
                >
                  {comp.status === "installing"
                    ? "Installing\u2026"
                    : comp.status === "removing"
                      ? "Removing\u2026"
                    : comp.status === "installed"
                      ? "Installed"
                    : comp.status === "removed"
                      ? "Removed"
                      : comp.status === "failed"
                        ? comp.error || "Failed"
                        : "Waiting"}
                </span>
              </div>
            ))}
          </div>

          {/* Expandable logs */}
          {installLogs.length > 0 && (
            <div className="border-t border-border/50">
              <button
                onClick={() => setLogsExpanded((v) => !v)}
                className="flex items-center gap-2 w-full px-5 py-3 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronDown
                  className={`size-3.5 transition-transform ${logsExpanded ? "rotate-180" : ""}`}
                />
                {progressLogsLabel} ({installLogs.length})
              </button>
              {logsExpanded && (
                <div className="max-h-[300px] overflow-y-auto px-4 pb-4 bg-muted/20 rounded-b-2xl">
                  <div className="space-y-0.5">
                    {installLogs.map((entry, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-2 text-xs font-mono leading-5"
                      >
                        <span className="w-[90px] shrink-0 text-muted-foreground/50 select-none truncate text-right">
                          {entry.component}
                        </span>
                        <span
                          className={`shrink-0 w-[38px] text-center text-[10px] font-semibold uppercase rounded px-1 py-px ${
                            entry.level === "error"
                              ? "text-red-500 bg-red-500/10"
                              : entry.level === "warn"
                                ? "text-yellow-500 bg-yellow-500/10"
                                : "text-muted-foreground/50 bg-muted/50"
                          }`}
                        >
                          {entry.level === "error" ? "ERR" : entry.level === "warn" ? "WRN" : "INF"}
                        </span>
                        <span
                          className={`flex-1 min-w-0 break-all ${
                            entry.level === "error"
                              ? "text-red-500"
                              : entry.level === "warn"
                                ? "text-yellow-500"
                                : "text-foreground/70"
                          }`}
                        >
                          {entry.message}
                        </span>
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
