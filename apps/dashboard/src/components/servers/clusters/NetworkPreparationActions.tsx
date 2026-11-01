"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useRef, useState } from "react";
import type { ManagedNetworkPreparation } from "@repo/core";
import { interpolate, useI18n } from "@/components/i18n-provider";
import DropdownMenu from "@/components/ui/DropdownMenu";
import { getApiErrorMessage } from "@/lib/api";
import { privateNetworksApi } from "@/lib/api/private-networks";
import { NetworkSetupConfirmation } from "./NetworkSetupConfirmation";

type PreparationActionTarget = Pick<ManagedNetworkPreparation, "id" | "sequence" | "status"> &
  Partial<Pick<ManagedNetworkPreparation, "cleanupOperationId" | "replacementPreparationId">>;

/** Shared by the setup card and preparation page; discard also cancels its unapplied plan. */
export function NetworkPreparationActions({
  preparation,
  name,
  canManage,
  disabled = false,
  onDiscarded,
  onRefresh,
  onBusyChange,
}: {
  preparation: PreparationActionTarget;
  name: string;
  canManage: boolean;
  disabled?: boolean;
  onDiscarded(preparation: ManagedNetworkPreparation): void;
  onRefresh(): void;
  onBusyChange?(busy: boolean): void;
}) {
  const { t } = useI18n();
  const m = t.servers.networks.managed;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const canDiscard =
    canManage &&
    !preparation.replacementPreparationId &&
    (preparation.status === "ready" ||
      preparation.status === "failed" ||
      preparation.status === "interrupted" ||
      // Only the full preparation can distinguish a paused setup from pending cleanup.
      (preparation.status === "pending" && preparation.cleanupOperationId === null));

  useEffect(() => {
    if (!canDiscard) setConfirming(false);
  }, [canDiscard]);

  const discard = async () => {
    if (!canDiscard || disabled || pending.current) return;
    pending.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const next = await privateNetworksApi.discardPreparation({
        preparationId: preparation.id,
        sequence: preparation.sequence,
      });
      setConfirming(false);
      onDiscarded(next);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      onRefresh();
      pending.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  if (!canDiscard) return null;
  return (
    <>
      <DropdownMenu
        disabled={disabled || busy}
        triggerLabel={interpolate(m.setupActions, { name })}
        actions={[
          {
            id: "discard",
            label: m.discardSetup,
            icon: <UiIcon name="trash" className="size-4" />,
            variant: "danger",
            onClick: () => {
              setError(null);
              setConfirming(true);
            },
          },
        ]}
      />
      {confirming && (
        <NetworkSetupConfirmation
          title={m.discardSetup}
          description={
            <>
              <strong className="font-medium text-foreground">{name}</strong>
              <br />
              {m.discardDescription}
            </>
          }
          confirmLabel={m.discardSetup}
          busy={busy}
          error={error}
          onClose={() => setConfirming(false)}
          onConfirm={() => void discard()}
        />
      )}
    </>
  );
}
