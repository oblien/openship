"use client";

import React, { useCallback, useEffect, useState } from "react";
import { ChevronDown, Cpu, Infinity as InfinityIcon, Loader2, SlidersHorizontal } from "lucide-react";
import {
  RESOURCE_TIER_ORDER,
  RESOURCE_TIER_SPECS,
  formatCpuCores,
  formatMemoryMb,
  type HostCapacity,
  type ResourceTier,
} from "@repo/core";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { getApiErrorMessage, projectsApi } from "@/lib/api";

/**
 * Project → machine power. Editable in place.
 *
 * The same tier vocabulary the cloud (Oblien) picker uses, plus two things that
 * only make sense self-hosted:
 *
 *   - "No limits" is a real, DEFAULT option. The operator owns the box, so the
 *     machine is the ceiling. Openship used to silently apply the cloud free
 *     tier (0.5 vCPU · 512 MB) to every self-hosted container, which OOM-killed
 *     memory-hungry images while the deploy still reported ready.
 *   - Custom is bounded by the TARGET MACHINE's probed capacity, shown inline,
 *     instead of a hardcoded 4-core / 8 GB ceiling that made a big box
 *     impossible to use.
 *
 * Cloud keeps the presets and cannot pick "no limits" — a metered workspace has
 * to be provisioned at a concrete size. The backend enforces that too
 * (`requiresLimit`); this component just doesn't offer the option.
 */

interface ResourcesView {
  production?: { cpuCores?: number; memoryMb?: number; diskMb?: number } | null;
  build?: { cpuCores?: number; memoryMb?: number; diskMb?: number } | null;
  tier?: ResourceTier;
  capacity?: HostCapacity;
  requiresLimit?: boolean;
}

/** Header doubles as the collapse toggle (same shape as RoutingConfigCard): a
 *  six-tile picker is a lot of vertical weight for a setting you touch rarely,
 *  so it stays tucked away with the live tier readable in the header. The
 *  divider belongs to the body, not the header — otherwise a collapsed card
 *  ends in a rule with nothing under it. */
function SectionCard({
  title,
  description,
  open,
  onToggle,
  summary,
  children,
}: {
  title: string;
  description: string;
  open: boolean;
  onToggle: () => void;
  summary?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-start transition-colors hover:bg-muted/20"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-500/10 text-orange-500">
            <Cpu className="size-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {summary}
          <ChevronDown
            className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </div>
      </button>
      {open && <div className="border-t border-border/40 px-5 py-4">{children}</div>}
    </div>
  );
}

export const ResourceSettings: React.FC = () => {
  const { id } = useProjectSettings();
  const { t } = useI18n();
  const { showToast } = useToast();
  const r = t.projectSettings.resources;

  const [view, setView] = useState<ResourcesView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<ResourceTier | null>(null);
  const [selected, setSelected] = useState<ResourceTier>("unlimited");
  const [customCpu, setCustomCpu] = useState("0");
  const [customMemory, setCustomMemory] = useState("0");
  const [showCustom, setShowCustom] = useState(false);
  const [open, setOpen] = useState(false);

  /** Seed every field from a server response. The custom inputs track the SAVED
   *  values even when a preset was chosen, so opening Custom afterwards starts
   *  from what's live rather than from whatever was last typed. */
  const applyView = useCallback((data: ResourcesView, fallbackTier?: ResourceTier) => {
    setView(data);
    setSelected(data.tier ?? fallbackTier ?? "unlimited");
    setCustomCpu(String(data.production?.cpuCores ?? 0));
    setCustomMemory(String(data.production?.memoryMb ?? 0));
  }, []);

  const load = useCallback(async () => {
    const res = await projectsApi.getResources(id);
    if (res.success && res.data) applyView(res.data as ResourcesView);
    setLoading(false);
  }, [id, applyView]);

  useEffect(() => {
    void load();
  }, [load]);

  const capacity = view?.capacity;
  const requiresLimit = view?.requiresLimit ?? false;
  // An unknown capacity means the probe couldn't reach the box. We still allow
  // the edit (blocking a save over a transient SSH failure would be worse) —
  // there's just no ceiling to display or enforce.
  const capacityKnown = !!capacity && capacity.source !== "unknown";

  const save = async (tier: ResourceTier, values?: { cpuCores: number; memoryMb: number }) => {
    if (saving) return;
    setSaving(tier);
    const res = await projectsApi.updateResources(id, {
      production: tier === "custom" ? { tier, ...values } : { tier },
    });
    if (res.success) {
      applyView(res.data as ResourcesView, tier);
      setShowCustom(false);
      showToast(r.toast.updated, "success");
    } else {
      showToast(getApiErrorMessage(res) || r.toast.updateFailed, "error");
    }
    setSaving(null);
  };

  const saveCustom = () => {
    const cpuCores = Number(customCpu);
    const memoryMb = Number(customMemory);
    if (!Number.isFinite(cpuCores) || !Number.isFinite(memoryMb) || cpuCores < 0 || memoryMb < 0) {
      showToast(r.toast.invalidValues, "error");
      return;
    }
    void save("custom", { cpuCores, memoryMb });
  };

  // "unlimited" leads on self-hosted because it's the default and the honest
  // answer for owned hardware; cloud never gets the option.
  const tiers: ResourceTier[] = requiresLimit
    ? [...RESOURCE_TIER_ORDER, "custom"]
    : ["unlimited", ...RESOURCE_TIER_ORDER, "custom"];

  const specLabel = (tier: ResourceTier): string => {
    if (tier === "unlimited") return r.tiers.unlimited.spec;
    if (tier === "custom") {
      const cpu = Number(customCpu) || 0;
      const mem = Number(customMemory) || 0;
      return cpu || mem ? `${formatCpuCores(cpu)} · ${formatMemoryMb(mem)}` : r.custom.notSet;
    }
    const spec = RESOURCE_TIER_SPECS[tier];
    return `${formatCpuCores(spec.cpuCores)} · ${formatMemoryMb(spec.memoryMb)}`;
  };

  const tierName = (tier: ResourceTier): string =>
    tier === "custom" ? r.custom.name : r.tiers[tier as keyof typeof r.tiers].name;
  const tierDescription = (tier: ResourceTier): string =>
    tier === "custom" ? r.custom.description : r.tiers[tier as keyof typeof r.tiers].description;

  // Collapsed-header readout of what's live. "No limits" already says it all, so
  // it doesn't get its "Machine capacity" spec appended.
  const summaryLabel = (): string =>
    selected === "unlimited"
      ? tierName("unlimited")
      : `${tierName(selected)} · ${specLabel(selected)}`;

  return (
    <SectionCard
      title={r.title}
      description={r.description}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      summary={
        loading ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <>
            {capacityKnown ? (
              <span className="hidden shrink-0 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1 text-[11px] font-medium text-muted-foreground sm:inline-block">
                {interpolate(r.machineCapacity, {
                  cpu: String(capacity!.cpuCores),
                  memory: formatMemoryMb(capacity!.memoryMb),
                })}
              </span>
            ) : null}
            <span className="truncate text-[12px] text-muted-foreground">{summaryLabel()}</span>
          </>
        )
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-2 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {r.loading}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {tiers.map((tier) => {
              const isSelected = selected === tier;
              const isSaving = saving === tier;
              // A preset larger than the machine can't be honored — offering it
              // would just produce a container that never gets what it asked for.
              const overCapacity =
                capacityKnown &&
                tier !== "unlimited" &&
                tier !== "custom" &&
                (RESOURCE_TIER_SPECS[tier].memoryMb > capacity!.memoryMb ||
                  RESOURCE_TIER_SPECS[tier].cpuCores > capacity!.cpuCores);
              return (
                <button
                  key={tier}
                  type="button"
                  disabled={!!saving || overCapacity}
                  onClick={() => {
                    if (tier === "custom") {
                      setSelected("custom");
                      setShowCustom(true);
                      return;
                    }
                    void save(tier);
                  }}
                  className={`relative flex items-start gap-3 rounded-xl border-2 p-3 text-start transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                    isSelected
                      ? "border-primary bg-primary/10"
                      : "border-transparent bg-muted/60 hover:bg-muted"
                  }`}
                >
                  <div
                    className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                      isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isSaving ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : tier === "unlimited" ? (
                      <InfinityIcon className="size-4" />
                    ) : tier === "custom" ? (
                      <SlidersHorizontal className="size-4" />
                    ) : (
                      <Cpu className="size-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-foreground">{tierName(tier)}</p>
                    <p className={`text-[11px] ${isSelected ? "text-primary" : "text-muted-foreground"}`}>
                      {tierDescription(tier)}
                    </p>
                    <p className="mt-1 text-[11px] font-medium text-foreground/70">
                      {overCapacity ? r.exceedsMachine : specLabel(tier)}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>

          {showCustom && selected === "custom" && (
            <div className="mt-3 space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
              <p className="text-[12px] text-muted-foreground">
                {capacityKnown
                  ? interpolate(r.customPanel.boundedBy, {
                      cpu: String(capacity!.cpuCores),
                      memory: formatMemoryMb(capacity!.memoryMb),
                    })
                  : r.customPanel.capacityUnknown}
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-foreground/70">
                    {r.customPanel.cpuCores}
                  </span>
                  <input
                    type="number"
                    min="0"
                    max={capacityKnown ? capacity!.cpuCores : undefined}
                    step="0.25"
                    value={customCpu}
                    onChange={(e) => setCustomCpu(e.target.value)}
                    className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <span className="text-[11px] text-muted-foreground">{r.customPanel.zeroMeansNoLimit}</span>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-foreground/70">
                    {r.customPanel.memory}
                  </span>
                  <input
                    type="number"
                    min="0"
                    max={capacityKnown ? capacity!.memoryMb : undefined}
                    step="128"
                    value={customMemory}
                    onChange={(e) => setCustomMemory(e.target.value)}
                    className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <span className="text-[11px] text-muted-foreground">{r.customPanel.zeroMeansNoLimit}</span>
                </label>
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowCustom(false);
                    setSelected(view?.tier ?? "unlimited");
                  }}
                  disabled={!!saving}
                  className="flex-1 rounded-lg border border-border/60 bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
                >
                  {r.customPanel.cancel}
                </button>
                <button
                  type="button"
                  onClick={saveCustom}
                  disabled={!!saving}
                  className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {saving ? r.customPanel.saving : r.customPanel.save}
                </button>
              </div>
            </div>
          )}

          {/* A cap only takes effect when the container is recreated. Saying so
              avoids the "I changed it and nothing happened" reading — which is
              exactly how the frozen-snapshot bug presented. */}
          <p className="mt-3 text-[11px] text-muted-foreground">{r.appliesOnNextDeploy}</p>
        </>
      )}
    </SectionCard>
  );
};
