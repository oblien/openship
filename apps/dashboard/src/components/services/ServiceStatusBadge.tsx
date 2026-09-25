"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useI18n } from "@/components/i18n-provider";
import type { Service, ServiceContainer } from "@/lib/api/services";

const STATUS_STYLES: Record<string, { ring: string; text: string; loading?: boolean }> = {
  checking: { ring: "", text: "text-muted-foreground", loading: true },
  running: { ring: "border-success-solid", text: "text-success" },
  stopped: { ring: "border-muted-foreground/40", text: "text-muted-foreground" },
  disabled: { ring: "border-muted-foreground/30", text: "text-muted-foreground/60" },
  failed: { ring: "border-danger-solid", text: "text-danger" },
  starting: { ring: "border-warning-solid motion-safe:animate-pulse", text: "text-warning" },
  restarting: { ring: "border-warning-solid motion-safe:animate-pulse", text: "text-warning" },
  building: { ring: "border-info-solid ring-3 ring-info-solid/15 motion-safe:animate-pulse", text: "text-info" },
  deploying: { ring: "border-info-solid ring-3 ring-info-solid/15 motion-safe:animate-pulse", text: "text-info" },
  built: { ring: "border-warning-solid", text: "text-warning" },
  pending: { ring: "border-muted-foreground/40", text: "text-muted-foreground" },
  unknown: { ring: "border-muted-foreground/40", text: "text-muted-foreground" },
};

/** The same hollow status ring in service badges and deployment tabs. */
export function ServiceStatusIndicator({ status, label }: { status: string; label?: string }) {
  const shown = STATUS_STYLES[status] ?? STATUS_STYLES.unknown;
  const accessibility = {
    role: label ? "img" : undefined,
    "aria-label": label,
    "aria-hidden": label ? undefined : true,
    title: label,
  } as const;
  return shown.loading ? (
    <UiIcon
      name="spinner"
      {...accessibility}
      className={`size-2.5 shrink-0 animate-spin ${shown.text}`}
    />
  ) : (
    <span {...accessibility} className={`size-2.5 shrink-0 rounded-full border-2 ${shown.ring}`} />
  );
}

/** Only a runtime response can say an enabled service is stopped. */
export function getServiceStatus(
  service: Pick<Service, "enabled">,
  container?: ServiceContainer,
  checking = false,
): string {
  return container?.status ?? (checking ? "checking" : service.enabled ? "unknown" : "disabled");
}

/** Shared by the service list and detail view so pending and unknown agree. */
export function ServiceStatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const labels = t.projects.serviceStatus;
  const deploymentLabels = t.importProject.serviceStatus;
  const shown = STATUS_STYLES[status] ?? STATUS_STYLES.unknown;
  const label =
    labels[status as keyof typeof labels] ??
    deploymentLabels[status as keyof typeof deploymentLabels] ??
    labels.unknown;
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${shown.text}`}
    >
      <ServiceStatusIndicator status={status} />
      {label}
    </span>
  );
}
