"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { useBillingWorkspace } from "@/components/billing/BillingWorkspaceContext";
import { useState } from "react";
import { api, getApiErrorMessage } from "@/lib/api/client";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

export function OpenStripePortalButton({
  label,
  enabled = false,
}: {
  label?: string;
  enabled?: boolean;
}) {
  const { t } = useI18n();
  const workspaceId = useBillingWorkspace();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonLabel = label ?? t.billing.portal.openButton;

  if (!enabled)
    return (
      <Button asChild variant="secondary">
        <a href="mailto:support@openship.io">
          {t.billing.portal.supportButton}
          <UiIcon name="arrow-up-right" className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
        </a>
      </Button>
    );

  async function openPortal() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const body = await api.post<{ data?: { portalUrl?: string }; portalUrl?: string }>(
        "billing/portal",
        { workspaceId },
      );
      const portalUrl = body.data?.portalUrl ?? body.portalUrl;
      if (!portalUrl) throw new Error(t.billing.portal.errorMissingUrl);
      window.location.href = portalUrl;
    } catch (err) {
      setError(getApiErrorMessage(err, t.billing.portal.errorOpenFailed));
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="secondary" onClick={openPortal} disabled={pending}>
        {pending && <UiIcon name="spinner" className="size-4 animate-spin" aria-hidden="true" />}
        {buttonLabel}
        {!pending && (
          <UiIcon name="arrow-up-right" className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
        )}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
