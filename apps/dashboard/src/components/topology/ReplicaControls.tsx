"use client";

import {
  MAX_WORKLOAD_REPLICAS,
  formatCpuCores,
  formatMemoryMb,
  type ProjectResources,
} from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";

export type ReplicaReview = { from: number; to: number; deploymentId: string; updatedAt: string };
export const validReplicaCount = (value: string) =>
  value.trim() !== "" &&
  Number.isInteger(Number(value)) &&
  Number(value) >= 1 &&
  Number(value) <= MAX_WORKLOAD_REPLICAS;

export function ReplicaCountInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      <label className="block space-y-1.5 text-xs text-muted-foreground">
        <span>{t.projects.quickScale.instances}</span>
        <input
          className="topology-input"
          type="number"
          min={1}
          max={MAX_WORKLOAD_REPLICAS}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {!validReplicaCount(value) && (
        <p role="alert" className="text-xs text-danger">
          Choose between 1 and {MAX_WORKLOAD_REPLICAS} instances.
        </p>
      )}
    </>
  );
}

export function ReplicaScaleReview({
  review,
  name,
  destination,
  resources,
  busy,
  disabled,
  stale,
  notice,
  onClose,
  onApply,
}: {
  review: ReplicaReview;
  name: string;
  destination: string;
  resources?: ProjectResources["production"];
  busy: boolean;
  disabled: boolean;
  stale: boolean;
  notice?: string;
  onClose: () => void;
  onApply: () => void;
}) {
  const { t } = useI18n();
  const text = t.projects.quickScale;
  return (
    <Modal
      isOpen
      onClose={() => {
        if (!busy) onClose();
      }}
      width="480px"
      maxWidth="96vw"
      showCloseButton={false}
      closable={!busy}
    >
      <div role="dialog" aria-modal="true" aria-label={text.review} className="space-y-5 p-6">
        <h2 className="text-lg font-medium">{text.review}</h2>
        <div className="rounded-xl bg-muted/40 p-4 text-sm">
          <p className="font-medium">{name}</p>
          <p className="mt-2">
            {review.from} → {review.to} {text.instances.toLowerCase()}
          </p>
          <p className="mt-1 text-muted-foreground">
            {destination} · {text.currentRelease}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          {notice ?? (review.to > review.from ? text.appScaleUp : text.appScaleDown)}
        </p>
        {resources && resources.cpuCores > 0 && resources.memoryMb > 0 && (
          <p className="text-sm text-muted-foreground">
            Per instance: {formatCpuCores(resources.cpuCores)} ·{" "}
            {formatMemoryMb(resources.memoryMb)}. Total limits:{" "}
            {formatCpuCores(resources.cpuCores * review.to)} ·{" "}
            {formatMemoryMb(resources.memoryMb * review.to)}.
          </p>
        )}
        {stale && (
          <p role="alert" className="text-sm text-warning">
            {text.settingsChanged}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t.settings.common.back}
          </Button>
          <Button disabled={disabled || stale} onClick={onApply}>
            {busy && <Icon name="spinner" className="size-4 animate-spin" />}
            {text.apply}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
