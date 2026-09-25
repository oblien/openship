"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { getApiErrorMessage } from "@/lib/api";
import { privateNetworksApi } from "@/lib/api/private-networks";
import { randomUUID } from "@/lib/random-uuid";
import { NetworkDiagnosticText } from "./NetworkSetupProgress";
import { NetworkSetupConfirmation } from "./NetworkSetupConfirmation";

type Source = { sequence: number } & (
  | { preparationId: string }
  | { operationId: string; planHash: string }
);

export function RemoveSetupServerButton({
  source,
  serverId,
  name,
  memberCount,
  disabled,
  onRefresh,
}: {
  source: Source;
  serverId: string;
  name: string;
  memberCount: number;
  disabled: boolean;
  onRefresh(): void;
}) {
  const { t } = useI18n();
  const m = t.servers.networks.managed;
  const router = useRouter();
  const hintId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const requestId = useRef<string | null>(null);
  const operation = "operationId" in source;
  async function remove() {
    if (pending.current || disabled || memberCount < 3) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    requestId.current ??= randomUUID();
    try {
      const result =
        "operationId" in source
          ? await privateNetworksApi.removeOperationMember({
              ...source,
              serverId,
              requestId: requestId.current,
            })
          : await privateNetworksApi.removePreparationMember({
              ...source,
              serverId,
              requestId: requestId.current,
            });
      setOpen(false);
      router.push(`/servers/networks/preparations/${result.preparation.id}`);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      pending.current = false;
      setBusy(false);
      onRefresh();
    }
  }
  return (
    <>
      <span
        className="inline-flex shrink-0"
        title={memberCount < 3 ? m.keepTwoServers : m.removeFromSetup}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-lg text-muted-foreground hover:bg-danger/10 hover:text-danger"
          aria-haspopup="dialog"
          aria-describedby={memberCount < 3 ? hintId : undefined}
          disabled={disabled || busy || memberCount < 3}
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          <UiIcon name="trash" className="size-4" aria-hidden="true" />
          <span className="sr-only">{m.removeFromSetup}</span>
        </Button>
        {memberCount < 3 && (
          <span id={hintId} className="sr-only">
            {m.keepTwoServers}
          </span>
        )}
      </span>
      {open && (
        <NetworkSetupConfirmation
          title={<NetworkDiagnosticText value={interpolate(m.removeSetupServerTitle, { name })} />}
          description={interpolate(
            operation ? m.removeSetupServerResetDescription : m.removeSetupServerDescription,
            { count: String(memberCount - 1) },
          )}
          confirmLabel={operation ? m.removeAndReset : m.removeFromSetup}
          busy={busy}
          error={error}
          onClose={() => setOpen(false)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}
