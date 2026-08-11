import {
  Shield,
  CheckCircle2,
  XCircle,
  Loader2,
  Download,
  RotateCcw,
  ChevronDown,
  ArrowUpCircle,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import type {
  ComponentStatus,
  SetupComponentProgress,
  SetupLogEvent,
} from "@/lib/api/system";
import { useI18n, interpolate } from "@/components/i18n-provider";

/** Component name → i18n key for its human/business role. The technical name
 *  (component.label, e.g. "OpenResty") stays as a small secondary tag. */
const ROLE_KEY: Record<string, string> = {
  docker: "roleDocker",
  git: "roleGit",
  openresty: "roleOpenresty",
  certbot: "roleCertbot",
  rsync: "roleRsync",
};

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
  const { t } = useI18n();
  const canRunAction = component.installable;
  // A newer package is available → the reinstall action upgrades to it, so lead
  // with "Update" (the same install action, apt-get install pulls the candidate).
  const isUpdate = Boolean(component.updateAvailable && component.installed);
  const actionLabel = component.healthy || component.installed ? t.servers.components.reinstall : t.servers.components.install;
  const canRemove = component.removable && component.installed;
  const removeDisabled = busy || component.removeSupported === false;

  // Lead with the human role ("Reverse proxy") and keep the technical name
  // ("OpenResty") as a small secondary tag. Falls back to the raw label for
  // any component without a mapped role.
  const techName = component.label || component.name;
  const roleName =
    (t.servers.components as Record<string, string>)[ROLE_KEY[component.name] ?? ""] ?? techName;
  const showTech = roleName !== techName;

  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-muted/30 transition-colors">
      <div className="shrink-0">
        {component.healthy ? (
          <CheckCircle2 className="size-5 text-success" />
        ) : (
          <XCircle className="size-5 text-warning" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">
            {roleName}
          </p>
          {showTech && (
            <span className="text-xs font-medium text-muted-foreground/70">
              {techName}
            </span>
          )}
          {component.version && (
            <span className="text-xs text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
              v{component.version}
            </span>
          )}
          {component.updateAvailable && component.availableVersion && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-warning bg-warning-bg px-1.5 py-0.5 rounded">
              <ArrowUpCircle className="size-3" />
              v{component.availableVersion}
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
            ? "bg-success-bg text-success"
            : "bg-warning-bg text-warning"
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
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors disabled:opacity-50 ${
                isUpdate
                  ? "border-warning-border bg-warning-bg text-warning hover:bg-warning-bg"
                  : "border-border/70 hover:bg-muted text-muted-foreground"
              }`}
            >
              {running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : isUpdate ? (
                <ArrowUpCircle className="size-3.5" />
              ) : component.healthy || component.installed ? (
                <RotateCcw className="size-3.5" />
              ) : (
                <Download className="size-3.5" />
              )}
              {running ? t.servers.components.running : isUpdate ? "Update" : actionLabel}
            </button>
          )}
          {canRemove && (
            <button
              onClick={() => onRemoveAction(component)}
              disabled={removeDisabled}
              title={component.removeBlockedReason}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border border-danger-border hover:bg-danger-bg transition-colors text-danger disabled:opacity-50"
            >
              {running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <XCircle className="size-3.5" />
              )}
              {running ? t.servers.components.running : component.removeSupported === false ? t.servers.components.unsupported : t.servers.components.remove}
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
  const { t } = useI18n();
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
        ? t.servers.components.removalComplete
        : t.servers.components.removalFinishedErrors
      : t.servers.components.removing
    : installDone
      ? installFinalStatus === "completed"
        ? t.servers.components.installComplete
        : t.servers.components.installFinishedErrors
      : t.servers.components.installing;
  const progressLogsLabel = actionMode === "remove" ? t.servers.components.removalLogs : t.servers.components.installLogs;

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
          <div className="w-9 h-9 bg-success-bg rounded-xl flex items-center justify-center">
            <Shield className="size-[18px] text-success" />
          </div>
          <div className="flex-1">
            <h2 className="font-semibold text-foreground text-[15px]">
              {t.servers.components.systemHealth}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t.servers.components.requiredComponents}
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
                ? actionMode === "remove" ? t.servers.components.removing : t.servers.components.installing
                : unhealthyInstallableCount > 0
                  ? interpolate(t.servers.components.installMissing, { count: String(unhealthyInstallableCount) })
                  : t.servers.components.allInstalled}
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
              {checking ? t.servers.components.checking : t.servers.components.recheck}
            </button>
          </div>
        </div>

        <div className="p-5 space-y-0.5">
          {checkError && (
            <div className="rounded-lg border border-danger-border bg-danger-bg p-3 mb-3">
              <p className="text-xs text-danger">
                {checkError}
              </p>
            </div>
          )}

          {checking && components.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                  {t.servers.components.runningHealthChecks}
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
                      {t.servers.components.detectedInfrastructure}
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
              {t.servers.components.noHealthData}
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
                    ? "bg-success-bg"
                    : "bg-danger-bg"
                  : "bg-primary/10"
              }`}
            >
              {installDone ? (
                installFinalStatus === "completed" ? (
                  <CheckCircle2 className="size-[18px] text-success" />
                ) : (
                  <XCircle className="size-[18px] text-danger" />
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
                {interpolate(t.servers.components.componentsCount, {
                  completed: String(completedCount),
                  total: String(streamComponents.length),
                })}
              </p>
            </div>
            {installDone && (
              <button
                onClick={onDismissInstall}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {t.servers.components.dismiss}
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
                      ? "bg-danger-solid"
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
                    <CheckCircle2 className="size-3.5 text-success" />
                  ) : comp.status === "failed" ? (
                    <XCircle className="size-3.5 text-danger" />
                  ) : (
                    <div className="size-3.5 rounded-full border-2 border-border/50" />
                  )}
                </div>
                <span className="text-sm font-medium text-foreground">
                  {comp.label}
                </span>
                <span
                  className={`ms-auto text-xs ${
                    comp.status === "installing" || comp.status === "removing"
                      ? "text-primary"
                      : comp.status === "installed" || comp.status === "removed"
                        ? "text-success"
                        : comp.status === "failed"
                          ? "text-danger"
                          : "text-muted-foreground"
                  }`}
                >
                  {comp.status === "installing"
                    ? t.servers.components.statusInstalling
                    : comp.status === "removing"
                      ? t.servers.components.statusRemoving
                    : comp.status === "installed"
                      ? t.servers.components.statusInstalled
                    : comp.status === "removed"
                      ? t.servers.components.statusRemoved
                      : comp.status === "failed"
                        ? comp.error || t.servers.components.statusFailed
                        : t.servers.components.statusWaiting}
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
                        <span className="w-[90px] shrink-0 text-muted-foreground/50 select-none truncate text-end">
                          {entry.component}
                        </span>
                        <span
                          className={`shrink-0 w-[38px] text-center text-[10px] font-semibold uppercase rounded px-1 py-px ${
                            entry.level === "error"
                              ? "text-danger bg-danger-bg"
                              : entry.level === "warn"
                                ? "text-warning bg-warning-bg"
                                : "text-muted-foreground/50 bg-muted/50"
                          }`}
                        >
                          {entry.level === "error" ? "ERR" : entry.level === "warn" ? "WRN" : "INF"}
                        </span>
                        <span
                          className={`flex-1 min-w-0 break-all ${
                            entry.level === "error"
                              ? "text-danger"
                              : entry.level === "warn"
                                ? "text-warning"
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
