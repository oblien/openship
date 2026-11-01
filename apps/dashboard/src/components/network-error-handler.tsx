"use client";

import { useEffect, useRef, useState } from "react";
import { api, setNetworkErrorHandler, setNetworkRecoveryHandler } from "@/lib/api/client";
import { useBrowserOnline } from "@/hooks/useBrowserOnline";
import { useI18n } from "@/components/i18n-provider";
import { ConnectionNotice } from "@/components/shared/ConnectionNotice";

/**
 * Mounts once in the root layout and registers a global handler so that any
 * Sustained transport failures show one compact notice. A short interruption
 * followed by a response never flashes a global warning. Retry checks liveness
 * only; it never replays the operation that failed.
 */
export function NetworkErrorHandler() {
  const { t } = useI18n();
  const online = useBrowserOnline();
  const [unavailable, setUnavailable] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retryInFlight = useRef(false);

  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    setNetworkErrorHandler(() => {
      // Do not postpone indefinitely when several polling requests fail.
      pending ??= setTimeout(() => setUnavailable(true), 1_500);
    });
    setNetworkRecoveryHandler(() => {
      clearTimeout(pending);
      pending = undefined;
      setUnavailable(false);
    });

    return () => {
      // Clear the handler when this component unmounts
      setNetworkErrorHandler(null);
      setNetworkRecoveryHandler(null);
      clearTimeout(pending);
    };
  }, []);

  if (online && !unavailable) return null;
  const c = t.issues.connectivity;
  const retry = async () => {
    if (retryInFlight.current) return;
    retryInFlight.current = true;
    setRetrying(true);
    try {
      await api.get("/health", { timeout: 5_000, dedupe: false, cache: "no-store" });
    } catch {
      // diagnostics-ignore: The API client observes failed liveness reads; retry never replays the original operation.
      // Reachability is updated by the client hooks. A failed probe keeps the
      // current notice; there is no second toast or retry of customer work.
    } finally {
      retryInFlight.current = false;
      setRetrying(false);
    }
  };
  return <div className="fixed bottom-4 start-4 end-4 z-50 ms-auto max-w-sm rounded-xl ring-1 ring-border/50">
    <ConnectionNotice
      compact
      title={online ? c.apiTitle : c.offlineTitle}
      message={online ? c.apiHint : c.offlineHint}
      onRetry={online ? retry : undefined}
      retrying={retrying}
    />
  </div>;
}
