"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useServerDestinations } from "@/hooks/useServerDestinations";
import { getApiErrorMessage } from "@/lib/api/client";

export function ServerCapacityRecovery({
  workspaceId,
  message,
  onClose,
  onRetry,
}: {
  workspaceId?: string;
  message?: string;
  onClose: () => void;
  onRetry?: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const copy = t.billing.workspaces;
  const title = useId();
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  const { data, error: fetchError, loading } = useServerDestinations();
  const server = data?.servers.find((row) => workspaceId ? row.managed?.id === workspaceId : data.servers.length === 1 && !!row.managed);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  async function retry() {
    if (!onRetry || retrying) return;
    setRetrying(true);
    setError(null);
    try {
      await onRetry();
    } catch (error) {
      setError(getApiErrorMessage(error));
    } finally {
      setRetrying(false);
    }
  }
  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="space-y-5 p-5 outline-none"
    >
      <h2 id={title} className="text-lg font-semibold">
        {copy.buildCapacityTitle}
      </h2>
      {message && <p className="text-sm">{message}</p>}
      <p className="text-sm text-muted-foreground">{copy.buildCapacityHint}</p>
      {(error || fetchError) && (
        <p role="alert" className="text-sm text-danger">
          {error || fetchError}
        </p>
      )}
      {!loading && !fetchError && !server && (
        <p role="alert" className="text-sm text-danger">
          {copy.noneAvailable}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {server && (
          <Button asChild>
            <Link
              href={`/servers/${encodeURIComponent(server.id)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {copy.openWorkspace}
            </Link>
          </Button>
        )}
        {onRetry && (
          <Button variant="secondary" disabled={retrying || loading} onClick={() => void retry()}>
            {copy.retryDeployment}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          {t.billing.deployGate.close}
        </Button>
      </div>
    </div>
  );
}
