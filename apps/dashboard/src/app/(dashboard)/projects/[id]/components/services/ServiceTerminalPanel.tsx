"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { useI18n } from "@/components/i18n-provider";
import { ConnectionNotice } from "@/components/shared/ConnectionNotice";
import { ServiceTerminal } from "@/components/terminal/ServiceTerminal";
import { TerminalCardShell } from "@/components/terminal/TerminalCardShell";
import { Button } from "@/components/ui/button";

type Props = Pick<ComponentProps<typeof ServiceTerminal>,
  "serviceId" | "name" | "theme" | "resumeToken" | "onResumeTokenChange"
> & {
  status: string;
  checking?: boolean;
  error?: string | null;
  onRefresh: () => void | Promise<void>;
  onSettings: () => void;
};

export function ServiceTerminalPanel({ status, checking, error, onRefresh, onSettings, ...terminal }: Props) {
  const { t } = useI18n();
  const copy = t.projectDetail.services.connection;
  const unverified = status === "checking" || status === "unknown";
  const starting = status === "starting" || status === "restarting" || status === "deploying" || status === "building";
  const canConnect = status === "running" || unverified || starting;
  const [opened, setOpened] = useState(status === "running");

  useEffect(() => {
    if (status === "running") setOpened(true);
    else if (!canConnect) setOpened(false);
  }, [status, canConnect]);
  const refreshAfterConnect = useCallback(() => {
    // Verify from the same runtime status endpoint; terminal access alone must
    // not optimistically relabel the service. A failed read cannot close the shell.
    void Promise.resolve().then(onRefresh).catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "dashboard/app/(dashboard)/projects/[id]/components/services/ServiceTerminalPanel");
    });
  }, [onRefresh]);

  // A status read is advisory. Keep an open shell through checking/unknown,
  // and let the existing authenticated terminal endpoint verify manual attempts.
  // A confirmed stopped/disabled service still closes the terminal normally.
  if (canConnect && (opened || status === "running")) {
    return <ServiceTerminal {...terminal} enabled onConnected={refreshAfterConnect} />;
  }

  return (
    <TerminalCardShell name={terminal.name ?? copy.terminal} className="min-h-[320px]">
      <div className="flex min-h-[220px] items-center justify-center py-5">
        <div className="w-full max-w-lg">
          <ConnectionNotice
            title={unverified
              ? status === "checking" ? copy.checkingTitle : copy.statusTitle
              : starting ? copy.startingTitle : copy.stoppedTitle}
            message={unverified
              ? status === "checking" ? copy.checkingHint : copy.statusHint
              : starting ? copy.startingHint : t.projectDetail.services.detail.startShellHint}
            detail={error || undefined}
            tone={status === "unknown" ? "warning" : "neutral"}
            onRetry={onRefresh}
            retrying={checking}
            actions={canConnect ? (
              <Button type="button" size="sm" onClick={() => setOpened(true)}>{copy.openTerminal}</Button>
            ) : (
              <Button type="button" size="sm" onClick={onSettings}>{copy.serviceSettings}</Button>
            )}
          />
        </div>
      </div>
    </TerminalCardShell>
  );
}
