import {
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import type { ComponentState } from "./types";

export function ComponentRow({
  component,
  showInstall,
}: {
  component: ComponentState;
  showInstall?: boolean;
}) {
  const isHealthy = component.status?.healthy;
  const isInstalling = component.installState === "installing";
  const isInstalled = component.installState === "installed";
  const isFailed = component.installState === "failed";

  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded-xl hover:bg-muted/30 transition-colors">
      <div className="shrink-0">
        {isInstalling ? (
          <Loader2 className="size-5 text-primary animate-spin" />
        ) : isInstalled || isHealthy ? (
          <CheckCircle2 className="size-5 text-emerald-500" />
        ) : isFailed ? (
          <XCircle className="size-5 text-red-500" />
        ) : (
          <div className="size-5 rounded-full border-2 border-border" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">{component.label}</p>
          {component.status?.version && (
            <span className="text-xs text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
              v{component.status.version}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {showInstall && isFailed
            ? component.installError ?? "Installation failed"
            : showInstall && isInstalling
              ? "Installing\u2026"
              : component.status?.message ?? component.description}
        </p>
      </div>

      {!showInstall && (
        <div
          className={`text-xs font-medium px-2.5 py-1 rounded-full ${
            isHealthy
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-orange-500/10 text-orange-600 dark:text-orange-400"
          }`}
        >
          {isHealthy ? "Ready" : "Missing"}
        </div>
      )}
    </div>
  );
}
