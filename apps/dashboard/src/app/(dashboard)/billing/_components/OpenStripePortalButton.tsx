"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useState } from "react";
import { api } from "@/lib/api/client";
import { useI18n } from "@/components/i18n-provider";

export function OpenStripePortalButton({ label, enabled = false }: { label?: string; enabled?: boolean }) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonLabel = label ?? t.billing.portal.openButton;

  if (!enabled) return (
    <a href="mailto:support@openship.io" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
      {t.billing.portal.supportButton}<UiIcon name="arrow-up-right" className="size-3.5" />
    </a>
  );

  async function openPortal() {
    setPending(true);
    setError(null);
    try {
      // Use the shared api client so the URL resolution respects
      // proxy mode + the new `/api`-suffixed base URL.
      const body = await api.post<{ data?: { portalUrl?: string }; portalUrl?: string }>(
        "billing/portal",
      );
      const portalUrl = body.data?.portalUrl ?? body.portalUrl;
      if (!portalUrl) {
        throw new Error(t.billing.portal.errorMissingUrl);
      }
      window.location.href = portalUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : t.billing.portal.errorOpenFailed);
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={openPortal}
        disabled={pending}
        className="group relative inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-primary-foreground transition-all disabled:opacity-60"
      >
        <span className="pointer-events-none absolute -inset-[1px] rounded-xl bg-gradient-to-r from-primary via-blue-500 to-violet-500 opacity-40 blur-[1px] transition-opacity group-hover:opacity-60" />
        <span className="absolute inset-0 rounded-xl bg-gradient-to-r from-primary to-primary/90" />
        <span className="relative flex items-center gap-1.5">
          {pending ? <UiIcon name="spinner" className="size-3.5 animate-spin" /> : null}
          {buttonLabel}
          {!pending ? <UiIcon name="arrow-up-right" className="size-3.5" /> : null}
        </span>
      </button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
