"use client";

import { useEffect, useState } from "react";
import type { BillingCustomQuote } from "@repo/contracts";
import type { CustomServerResources } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { billingApi } from "@/lib/api/billing";
import { getApiErrorMessage } from "@/lib/api/client";

/** Read-only quote, shared by monthly checkout and prepaid price comparisons. */
export function useCustomPlanQuote(resources: CustomServerResources | null, revision = 0, interval: "monthly" | "annual" = "monthly") {
  const { t } = useI18n();
  const resourceKey = JSON.stringify(resources);
  const requestKey = `${resourceKey}:${interval}:${revision}`;
  const [result, setResult] = useState<{ key: string; quote: BillingCustomQuote } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(Boolean(resources));

  useEffect(() => {
    let disposed = false;
    setError(null);
    setPending(resourceKey !== "null");
    if (resourceKey === "null") return;
    const timer = setTimeout(() => {
      void billingApi
        .quoteCustomPlan(JSON.parse(resourceKey) as CustomServerResources, interval)
        .then((quote) => {
          if (!disposed) setResult({ key: requestKey, quote });
        })
        .catch((failure) => {
          if (!disposed) setError(getApiErrorMessage(failure, t.billing.custom.quoteError));
        })
        .finally(() => {
          if (!disposed) setPending(false);
        });
    }, 200);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [resourceKey, requestKey, interval, attempt, t.billing.custom.quoteError]);

  // Never expose a stale price while another resource selection is being quoted.
  const quote = resources && !pending && !error && result?.key === requestKey ? result.quote : null;
  return { quote, pending, error, retry: () => setAttempt((value) => value + 1) };
}
