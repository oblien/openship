"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n-provider";
import { billingApi } from "@/lib/api/billing";

/** A return URL starts polling; only a fresh provider entitlement confirms access. */
export function BillingCheckoutStatus({ kind, expectedTier, expectedInterval }: {
  kind: "subscription" | "topup";
  expectedTier?: string;
  expectedInterval?: "monthly" | "annual";
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [status, setStatus] = useState<"checking" | "active" | "pending">("checking");

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 30_000;
    async function refresh() {
      try {
        const state = await billingApi.getBillingState();
        if (disposed) return;
        router.refresh();
        if (kind === "subscription" && expectedTier && state.tier === expectedTier && state.status === "active"
          && (!expectedInterval || state.subscription?.interval === expectedInterval)) {
          setStatus("active");
          return;
        }
      } catch {
        // A provider outage does not confirm or undo a payment. Retry briefly.
      }
      if (disposed) return;
      if (Date.now() >= deadline) setStatus("pending");
      else timer = setTimeout(refresh, 3_000);
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [kind, expectedTier, expectedInterval, router]);

  return <div role="status" aria-live="polite" className="mb-6 rounded-lg border border-border bg-muted/30 p-4 text-sm">
    <p>{t.billing.checkout[status]}</p>
    {status === "pending" && <a className="mt-2 inline-block underline" href="mailto:support@openship.io">{t.billing.checkout.support}</a>}
  </div>;
}
