import { Download, CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import type { SetupComponentProgress, SetupLogEvent } from "@/lib/api/system";

function ComponentProgressRow({ component }: { component: SetupComponentProgress }) {
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

function LogLine({ entry }: { entry: SetupLogEvent }) {
  return (
    <div className="flex gap-2 text-xs font-mono leading-5">
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
  );
}

export function InstallingPanel({
  components,
  logs,
  serverHost,
  isDone,
  finalStatus,
  onDone,
  onRetry,
}: {
  components: SetupComponentProgress[];
  logs: SetupLogEvent[];
  serverHost: string;
  isDone: boolean;
  finalStatus: "completed" | "failed" | null;
  onDone: () => void;
  onRetry: () => void;
}) {
  const [logsExpanded, setLogsExpanded] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (logsExpanded && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs.length, logsExpanded]);

  const installedCount = components.filter((c) => c.status === "installed").length;
  const failedCount = components.filter((c) => c.status === "failed").length;
  const totalCount = components.length;
  const progressPercent = totalCount > 0
    ? Math.round(((installedCount + failedCount) / totalCount) * 100)
    : 0;

  return (
    <div className="space-y-4">
      {/* Progress card */}
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center ${
              isDone
                ? finalStatus === "completed"
                  ? "bg-emerald-500/10"
                  : "bg-red-500/10"
                : "bg-primary/10"
            }`}
          >
            {isDone ? (
              finalStatus === "completed" ? (
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
              {isDone
                ? finalStatus === "completed"
                  ? "Setup Complete"
                  : "Setup Finished with Errors"
                : "Installing Components"}
            </h2>
            <p className="text-xs text-muted-foreground">
              {isDone
                ? `${installedCount} of ${totalCount} installed on ${serverHost}`
                : `Setting up ${serverHost}\u2026`}
            </p>
          </div>
          {!isDone && (
            <span className="text-xs font-medium text-muted-foreground">
              {installedCount}/{totalCount}
            </span>
          )}
        </div>

        {/* Progress bar */}
        {!isDone && (
          <div className="px-5 pt-3">
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-500 ease-out"
                style={{ width: `${Math.max(progressPercent, installedCount === 0 ? 2 : progressPercent)}%` }}
              />
            </div>
          </div>
        )}

        {/* Component rows */}
        <div className="p-5 pt-3 space-y-0.5">
          {components.map((comp) => (
            <ComponentProgressRow key={comp.name} component={comp} />
          ))}
        </div>
      </div>

      {/* Log output */}
      <div className="bg-card rounded-2xl border border-border/50">
        <button
          onClick={() => setLogsExpanded(!logsExpanded)}
          className="flex items-center gap-2 w-full px-5 py-3 text-left hover:bg-muted/30 transition-colors rounded-t-2xl"
        >
          {logsExpanded ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
          <span className="text-sm font-medium text-foreground">
            Install Logs
          </span>
          <span className="text-xs text-muted-foreground">
            ({logs.length} {logs.length === 1 ? "line" : "lines"})
          </span>
        </button>

        {logsExpanded && (
          <div className="border-t border-border/50">
            <div className="max-h-[400px] overflow-y-auto p-4 bg-muted/20 rounded-b-2xl">
              {logs.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  Waiting for output\u2026
                </p>
              ) : (
                <div className="space-y-0.5">
                  {logs.map((entry, i) => (
                    <LogLine key={i} entry={entry} />
                  ))}
                  <div ref={logEndRef} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Action buttons when done */}
      {isDone && (
        <div className="flex items-center gap-3">
          <button
            onClick={onDone}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all"
          >
            <CheckCircle2 className="size-4" />
            {finalStatus === "completed" ? "Done — Go to Servers" : "Go to Servers"}
          </button>
          {failedCount > 0 && (
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
