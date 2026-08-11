import {
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import type { ComponentState } from "./types";
import { useI18n } from "@/components/i18n-provider";

/** Component name → i18n key for its human/business role; technical name stays
 *  as a small secondary tag. Mirrors the server-detail health list. */
const ROLE_KEY: Record<string, string> = {
  docker: "roleDocker",
  git: "roleGit",
  openresty: "roleOpenresty",
  certbot: "roleCertbot",
  rsync: "roleRsync",
};

export function ComponentRow({
  component,
  showInstall,
}: {
  component: ComponentState;
  showInstall?: boolean;
}) {
  const { t } = useI18n();
  const isHealthy = component.status?.healthy;
  const techName = component.label || component.name;
  const roleName =
    (t.servers.components as Record<string, string>)[ROLE_KEY[component.name] ?? ""] ?? techName;
  const showTech = roleName !== techName;
  const isInstalling = component.installState === "installing";
  const isInstalled = component.installState === "installed";
  const isFailed = component.installState === "failed";

  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded-xl hover:bg-muted/30 transition-colors">
      <div className="shrink-0">
        {isInstalling ? (
          <Loader2 className="size-5 text-primary animate-spin" />
        ) : isInstalled || isHealthy ? (
          <CheckCircle2 className="size-5 text-success" />
        ) : isFailed ? (
          <XCircle className="size-5 text-danger" />
        ) : (
          <div className="size-5 rounded-full border-2 border-border" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">{roleName}</p>
          {showTech && (
            <span className="text-xs font-medium text-muted-foreground">{techName}</span>
          )}
          {component.status?.version && (
            <span className="text-xs text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
              v{component.status.version}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {showInstall && isFailed
            ? component.installError ?? t.servers.setup.installationFailed
            : showInstall && isInstalling
              ? t.servers.setup.installing
              : component.status?.message ?? component.description}
        </p>
      </div>

      {!showInstall && (
        <div
          className={`text-xs font-medium px-2.5 py-1 rounded-full ${
            isHealthy
              ? "bg-success-bg text-success"
              : "bg-warning-bg text-warning"
          }`}
        >
          {isHealthy ? t.servers.setup.ready : t.servers.setup.missing}
        </div>
      )}
    </div>
  );
}
