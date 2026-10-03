"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  MIN_CPU_CORES, MIN_MEMORY_MB, RESOURCE_TIER_ORDER, RESOURCE_TIER_SPECS,
  UNKNOWN_CAPACITY, formatCpuCores, formatMemoryMb, validateAgainstCapacity,
  type HostCapacity, type ResourceTier, type ResourceValues,
} from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionCard } from "@/components/shared/OptionCard";
import { useI18n, interpolate } from "@/components/i18n-provider";

export type ResourceLimitValues = Pick<ResourceValues, "cpuCores" | "memoryMb">;

/** Every surface reads the same tier copy, with a fallback for a missing translation. */
export function useResourceTierLabels() {
  const { t } = useI18n();
  const copy = t.projectSettings.resources;
  const details = (tier: ResourceTier): { name?: string; description?: string } | undefined =>
    tier === "custom" ? copy.custom : (copy.tiers as Record<string, { name?: string; description?: string }>)[tier];
  return {
    name: (tier: ResourceTier) => details(tier)?.name ?? tier,
    description: (tier: ResourceTier) => details(tier)?.description ?? "",
    spec: (tier: ResourceTier, custom: ResourceLimitValues) => {
      if (tier === "unlimited") return copy.tiers.unlimited.spec;
      const values = tier === "custom" ? custom : RESOURCE_TIER_SPECS[tier];
      return values.cpuCores || values.memoryMb
        ? `${formatCpuCores(values.cpuCores)} · ${formatMemoryMb(values.memoryMb)}`
        : copy.custom.notSet;
    },
  };
}

interface ResourceTierPickerProps {
  value: ResourceTier;
  values: ResourceLimitValues;
  requiresLimit?: boolean;
  capacity?: Pick<HostCapacity, "cpuCores" | "memoryMb">;
  saving?: ResourceTier | null;
  disabled?: boolean;
  /** Separate full capacity from the presets and custom limits. */
  showModeSelector?: boolean;
  /** An unfinished choice must be completed or cancelled before continuing. */
  onPendingChange?: (pending: boolean) => void;
  /** False keeps a custom draft open after a failed save. */
  onSelect: (tier: ResourceTier, values?: ResourceLimitValues) => void | boolean | Promise<boolean>;
}

/** Project settings and deployment setup share the same limits editor. */
export function ResourceTierPicker({ value, values, requiresLimit = false, capacity, saving, disabled, showModeSelector = false, onPendingChange, onSelect }: ResourceTierPickerProps) {
  const { t } = useI18n();
  const copy = t.projectSettings.resources;
  const labels = useResourceTierLabels();
  const fieldId = useId();
  const fullRef = useRef<HTMLButtonElement>(null);
  const customRef = useRef<HTMLButtonElement>(null);
  const [customizing, setCustomizing] = useState(false);
  const [draft, setDraft] = useState<{ cpu: string; memory: string } | null>(null);
  const [saveError, setSaveError] = useState(false);
  const useModes = showModeSelector && !requiresLimit;
  const customized = value !== "unlimited" || customizing;
  const selected = draft ? "custom" : value;
  const tiers: ResourceTier[] = requiresLimit || useModes ? [...RESOURCE_TIER_ORDER, "custom"] : ["unlimited", ...RESOURCE_TIER_ORDER, "custom"];
  const busy = disabled || !!saving;
  const custom = draft ? { cpuCores: Number(draft.cpu), memoryMb: Number(draft.memory) } : values;
  const invalidNumbers = !Number.isFinite(custom.cpuCores) || !Number.isFinite(custom.memoryMb)
    || custom.cpuCores < 0 || custom.memoryMb < 0
    || (requiresLimit && (custom.cpuCores === 0 || custom.memoryMb === 0));
  const invalidCustom = invalidNumbers || !!validateAgainstCapacity(
    { ...custom, diskMb: 0 }, { ...UNKNOWN_CAPACITY, ...capacity },
  );
  const incomplete = !!draft && (!draft.cpu.trim() || !draft.memory.trim());
  const pending = useModes && ((customizing && value === "unlimited") || !!draft);

  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [onPendingChange, pending]);

  const cancelDraft = () => {
    setDraft(null);
    setSaveError(false);
    setCustomizing(false);
    if (useModes && value === "unlimited") fullRef.current?.focus();
    else customRef.current?.focus();
  };

  const commit = async (tier: ResourceTier, customValues?: ResourceLimitValues) => {
    if (busy) return;
    setSaveError(false);
    try {
      if (await onSelect(tier, customValues) !== false) {
        setDraft(null);
        setCustomizing(false);
        if (useModes && tier === "unlimited") fullRef.current?.focus();
        else if (tier === "custom") customRef.current?.focus();
      }
    } catch {
      setSaveError(true);
    }
  };

  return (
    <div className="@container/resources space-y-3">
      {useModes && (
        <div className="grid grid-cols-1 items-stretch gap-3 @min-[24rem]/resources:grid-cols-2">
          <OptionCard
            value="unlimited"
            buttonRef={fullRef}
            selected={!customized}
            disabled={busy}
            onSelect={() => void commit("unlimited")}
            icon={<Icon name="infinity" className="size-5" />}
            label={labels.name("unlimited")}
            description={labels.description("unlimited")}
          />
          <OptionCard
            value="customized"
            selected={customized}
            disabled={busy}
            onSelect={() => setCustomizing(true)}
            icon={<Icon name="sliders" className="size-5" />}
            label={copy.customized.name}
            description={copy.customized.description}
          />
        </div>
      )}
      <div hidden={useModes && !customized} className="space-y-3">
        <div className="grid grid-cols-1 items-stretch gap-3 @min-[24rem]/resources:grid-cols-2 @min-[40rem]/resources:grid-cols-3">
          {tiers.map(tier => {
            const active = selected === tier;
            const overCapacity = tier !== "custom" && tier !== "unlimited" && capacity && (
              (capacity.cpuCores > 0 && RESOURCE_TIER_SPECS[tier].cpuCores > capacity.cpuCores)
              || (capacity.memoryMb > 0 && RESOURCE_TIER_SPECS[tier].memoryMb > capacity.memoryMb)
            );
            return (
              <OptionCard
                key={tier}
                value={tier}
                buttonRef={tier === "custom" ? customRef : undefined}
                selected={active}
                disabled={busy || !!overCapacity}
                onSelect={() => {
                  if (tier === "custom") {
                    setDraft({ cpu: String(values.cpuCores), memory: String(values.memoryMb) });
                    setSaveError(false);
                  } else void commit(tier);
                }}
                className={tier === "unlimited" ? "col-span-full" : undefined}
                icon={<Icon name={saving === tier ? "spinner" : tier === "unlimited" ? "infinity" : tier === "custom" ? "sliders" : "cpu"} className={`size-4 ${saving === tier ? "animate-spin" : ""}`} />}
                label={labels.name(tier)}
                description={(
                  <>
                    <span>{labels.description(tier)}</span>
                    <span className="mt-1 block font-medium text-foreground/70">
                      {overCapacity ? copy.exceedsMachine : <bdi dir={tier === "unlimited" || (tier === "custom" && !values.cpuCores && !values.memoryMb) ? "auto" : "ltr"}>{labels.spec(tier, values)}</bdi>}
                    </span>
                  </>
                )}
              />
            );
          })}
        </div>
        {draft && (
          <div className="space-y-4 rounded-xl bg-muted/30 p-4">
            {capacity && <p className="text-xs text-muted-foreground">{interpolate(copy.machineCapacity, { cpu: String(capacity.cpuCores), memory: formatMemoryMb(capacity.memoryMb) })}</p>}
            <div className="grid grid-cols-1 gap-4 @min-[24rem]/resources:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor={`${fieldId}-cpu`} className="text-sm font-medium">{copy.customPanel.cpuCores}</label>
                <Input id={`${fieldId}-cpu`} aria-describedby={`${fieldId}-cpu-hint`} type="number" variant="filled" min={requiresLimit ? MIN_CPU_CORES : 0} max={capacity?.cpuCores || undefined} step="0.25" value={draft.cpu} disabled={busy} onChange={event => setDraft({ ...draft, cpu: event.target.value })} />
                <p id={`${fieldId}-cpu-hint`} className="text-xs text-muted-foreground">
                  <bdi dir={requiresLimit ? "ltr" : "auto"}>
                  {requiresLimit ? (capacity?.cpuCores
                    ? `${formatCpuCores(MIN_CPU_CORES)} – ${formatCpuCores(capacity.cpuCores)}`
                    : `≥ ${formatCpuCores(MIN_CPU_CORES)}`) : copy.customPanel.zeroMeansNoLimit}
                  </bdi>
                </p>
              </div>
              <div className="space-y-1.5">
                <label htmlFor={`${fieldId}-memory`} className="text-sm font-medium">{copy.customPanel.memory}</label>
                <Input id={`${fieldId}-memory`} aria-describedby={`${fieldId}-memory-hint`} type="number" variant="filled" min={requiresLimit ? MIN_MEMORY_MB : 0} max={capacity?.memoryMb || undefined} step="128" value={draft.memory} disabled={busy} onChange={event => setDraft({ ...draft, memory: event.target.value })} />
                <p id={`${fieldId}-memory-hint`} className="text-xs text-muted-foreground">
                  <bdi dir={requiresLimit ? "ltr" : "auto"}>
                  {requiresLimit ? (capacity?.memoryMb
                    ? `${formatMemoryMb(MIN_MEMORY_MB)} – ${formatMemoryMb(capacity.memoryMb)}`
                    : `≥ ${formatMemoryMb(MIN_MEMORY_MB)}`) : copy.customPanel.zeroMeansNoLimit}
                  </bdi>
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={cancelDraft}>{copy.customPanel.cancel}</Button>
              <Button type="button" disabled={busy || incomplete || invalidCustom} onClick={() => void commit("custom", custom)}>{saving ? copy.customPanel.saving : copy.customPanel.save}</Button>
            </div>
          </div>
        )}
      </div>
      {saveError && <p role="alert" className="text-sm text-danger">{copy.toast.updateFailed}</p>}
    </div>
  );
}
