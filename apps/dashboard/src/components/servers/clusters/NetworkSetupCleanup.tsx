"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useRef, useState } from "react";
import Link from "next/link";
import { managedNetworkInProgress, managedNetworkSteps } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useNetworkSetup } from "@/hooks/useNetworkSetup";
import { getApiErrorMessage } from "@/lib/api";
import { privateNetworksApi } from "@/lib/api/private-networks";
import { NetworkSetupProgress } from "./NetworkSetupProgress";
import { NetworkStreamNotice } from "./NetworkStreamNotice";

/** Follow the original operation until every host has acknowledged its reset. */
export function NetworkSetupCleanup({
  operationId,
  memberCount,
  canManage,
  disabled,
  onContinue,
}: {
  operationId: string;
  memberCount: number;
  canManage: boolean;
  disabled: boolean;
  onContinue(): void;
}) {
  const { t } = useI18n();
  const m = t.servers.networks.managed;
  const { progress: operation, update, stream } = useNetworkSetup("operation", operationId, true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const running = !!operation && managedNetworkInProgress(operation.status);
  async function retry() {
    if (!operation || pending.current || !canManage || disabled) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      update(
        await privateNetworksApi.applyManaged({
          operationId,
          planHash: operation.planHash,
          action: "rollback",
        }),
      );
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      pending.current = false;
      setBusy(false);
      stream.reconnect();
    }
  }
  return (
    <div className="min-w-0 space-y-5">
      <div className="space-y-3 rounded-2xl bg-card p-5 sm:p-6">
        <h2 className="text-base font-semibold">
          {operation?.status === "rolled_back" ? m.status.rolled_back : m.resetBeforeContinue}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {interpolate(m.resetBeforeContinueDescription, { count: String(memberCount) })}
        </p>
        <NetworkStreamNotice stream={stream} />
        {operation && (
          <p role="status" className="text-sm font-medium">
            {m.status[operation.status]}
          </p>
        )}
        {(error || operation?.error) && (
          <p role="alert" className="text-sm leading-relaxed text-danger">
            {error || operation?.error}
          </p>
        )}
        {canManage &&
          operation &&
          ["interrupted", "needs_attention"].includes(operation.status) && (
            <Button
              onClick={() => void retry()}
              disabled={busy || disabled}
              className="h-auto min-h-10 max-w-full whitespace-normal py-2"
            >
              {busy ? (
                <UiIcon name="spinner" className="size-4 animate-spin" />
              ) : (
                <UiIcon name="rotate-left" className="size-4" />
              )}
              {m.retryCleanup}
            </Button>
          )}
        {canManage && operation?.status === "rolled_back" && (
          <Button
            onClick={onContinue}
            disabled={disabled || busy}
            className="h-auto min-h-10 max-w-full whitespace-normal py-2"
          >
            {disabled ? (
              <UiIcon name="spinner" className="size-4 animate-spin" />
            ) : (
              <UiIcon name="rotate-left" className="size-4" />
            )}
            {m.retryPreparation}
          </Button>
        )}
        <Link
          href={`/servers/networks/operations/${operationId}`}
          className="block text-sm font-medium text-primary hover:underline"
        >
          {m.viewCleanup}
        </Link>
      </div>
      {operation && (
        <NetworkSetupProgress
          running={running}
          hosts={operation.hosts.map((host) => {
            const planned = operation.plan.hosts.find((item) => item.serverId === host.serverId)!;
            const steps = host.steps?.length
              ? host.steps
              : managedNetworkSteps(["rollback"]).map((step) => ({
                  ...step,
                  status:
                    host.stage === "rolled_back"
                      ? ("completed" as const)
                      : host.error
                        ? ("failed" as const)
                        : ("pending" as const),
                  message: host.error,
                }));
            return {
              serverId: host.serverId,
              name: planned.name,
              address: planned.endpoint,
              steps,
              logs: host.logs ?? [],
            };
          })}
        />
      )}
    </div>
  );
}
