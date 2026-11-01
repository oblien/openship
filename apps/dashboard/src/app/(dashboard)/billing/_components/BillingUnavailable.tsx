"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";
import type { ReactNode } from "react";
import Link from "next/link";
import { useCloud } from "@/context/CloudContext";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";

export type BillingUnavailableReason =
  | "workspace-required"
  | "saas-not-enabled"
  | "billing-not-configured"
  | "billing-forbidden"
  | "billing-sign-in-required"
  | "billing-unreachable"
  | "cloud-not-connected"
  | "cloud-session-expired"
  | "cloud-unreachable";

function UnavailablePanel({
  title,
  description,
  icon = "alert-circle",
  children,
}: {
  title: string;
  description: string;
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
          <UiIcon name={icon} className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-medium text-foreground">{title}</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">{children}</div>
    </section>
  );
}

/** Reuse the Cloud connection flow; purchase, access and network failures stay distinct. */
export function BillingUnavailable({ reason }: { reason: BillingUnavailableReason }) {
  const { t } = useI18n();
  const { startConnect, connecting, refresh } = useCloud();

  function handleRetry() {
    const reload = () => window.location.reload();
    if (reason === "cloud-unreachable") void refresh().then(reload, reload);
    else reload();
  }

  if (reason === "workspace-required")
    return (
      <UnavailablePanel
        icon="cloud"
        title={t.billing.workspaces.title}
        description={t.billing.workspaces.chooseBilling}
      >
        <Button asChild variant="secondary">
          <Link href="/servers">{t.billing.workspaces.manage}</Link>
        </Button>
      </UnavailablePanel>
    );

  if (
    reason === "cloud-not-connected" ||
    reason === "cloud-session-expired" ||
    reason === "cloud-unreachable"
  ) {
    const copy =
      reason === "cloud-not-connected"
        ? t.billing.unavailable.notConnected
        : reason === "cloud-session-expired"
          ? t.billing.unavailable.sessionExpired
          : t.billing.unavailable.unreachable;
    const connectLabel =
      reason === "cloud-not-connected"
        ? t.billing.unavailable.notConnected.connect
        : reason === "cloud-session-expired"
          ? t.billing.unavailable.sessionExpired.reconnect
          : t.billing.unavailable.unreachable.reconnect;
    return (
      <UnavailablePanel
        title={copy.title}
        description={copy.description}
        icon={reason === "cloud-not-connected" ? "cloud" : "alert-circle"}
      >
        <Button onClick={startConnect} disabled={connecting}>
          {connecting && (
            <UiIcon name="spinner" className="size-4 animate-spin" aria-hidden="true" />
          )}
          {connecting ? t.billing.unavailable.notConnected.connecting : connectLabel}
        </Button>
        {reason === "cloud-unreachable" && (
          <Button variant="secondary" onClick={handleRetry}>
            {t.billing.unavailable.unreachable.tryAgain}
          </Button>
        )}
      </UnavailablePanel>
    );
  }

  const content = {
    "saas-not-enabled": t.billing.unavailable.notEnabled,
    "billing-not-configured": t.billing.unavailable.notConfigured,
    "billing-forbidden": t.billing.unavailable.forbidden,
    "billing-sign-in-required": t.billing.unavailable.signInRequired,
    "billing-unreachable": t.billing.unavailable.loadFailed,
  }[reason];

  return (
    <UnavailablePanel title={content.title} description={content.description}>
      {reason === "billing-sign-in-required" ? (
        <Button asChild>
          <Link href="/login">{t.billing.unavailable.signInRequired.signIn}</Link>
        </Button>
      ) : (
        <Button variant="secondary" onClick={handleRetry}>
          {t.billing.unavailable.unreachable.tryAgain}
        </Button>
      )}
    </UnavailablePanel>
  );
}
