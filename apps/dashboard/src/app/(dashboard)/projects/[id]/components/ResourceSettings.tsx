"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  formatMemoryMb,
  type ProjectResources,
  type ResourceTier,
} from "@repo/core";
import { ResourceTierPicker, useResourceTierLabels } from "@/components/deploy/ResourceTierPicker";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { getApiErrorMessage, projectsApi } from "@/lib/api";

/** Persisted resource settings use the same limits editor as deployment setup. */

/** Header doubles as the collapse toggle (same shape as RoutingConfigCard): a
 *  preset picker is a lot of vertical weight for a setting you touch rarely,
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
            <UiIcon name="cpu" className="size-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {summary}
          <UiIcon name="chevron-down"
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
  const labels = useResourceTierLabels();

  const [view, setView] = useState<ProjectResources | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<ResourceTier | null>(null);
  const [open, setOpen] = useState(false);
  const loadRequest = useRef(0);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    setLoadError(null);
    try {
      const { data } = await projectsApi.getResources(id);
      if (request === loadRequest.current) setView(data);
    } catch (err) {
      if (request === loadRequest.current) {
        setLoadError(getApiErrorMessage(err, r.loadFailed));
      }
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [id, r.loadFailed]);

  useEffect(() => {
    void load();
    return () => {
      loadRequest.current += 1;
    };
  }, [load]);

  const capacity = view?.capacity;
  const requiresLimit = view?.requiresLimit ?? false;
  // An unknown capacity means the probe couldn't reach the box. We still allow
  // the edit (blocking a save over a transient SSH failure would be worse) —
  // there's just no ceiling to display or enforce.
  const capacityKnown = !!capacity && capacity.source !== "unknown";

  const save = async (tier: ResourceTier, values?: { cpuCores: number; memoryMb: number }) => {
    if (saving) return false;
    setSaving(tier);
    try {
      const { data } = await projectsApi.updateResources(id, {
        production: tier === "custom" ? { tier, ...values } : { tier },
      });
      setView(data);
      showToast(r.toast.updated, "success");
      return true;
    } catch (err) {
      showToast(getApiErrorMessage(err, r.toast.updateFailed), "error");
      return false;
    } finally {
      setSaving(null);
    }
  };

  const summaryLabel = view
    ? view.tier === "unlimited" ? labels.name(view.tier)
      : `${labels.name(view.tier)} · ${labels.spec(view.tier, view.production)}`
    : "";

  return (
    <SectionCard
      title={r.title}
      description={r.description}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      summary={
        loading ? (
          <UiIcon name="spinner" className="size-3.5 animate-spin text-muted-foreground" />
        ) : loadError ? (
          <span className="truncate text-[12px] text-destructive">{r.unavailable}</span>
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
            <span className="truncate text-[12px] text-muted-foreground">{summaryLabel}</span>
          </>
        )
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-2 text-[13px] text-muted-foreground">
          <UiIcon name="spinner" className="size-3.5 animate-spin" />
          {r.loading}
        </div>
      ) : loadError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3"
        >
          <p className="text-[12px] text-destructive">{loadError}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 rounded-lg border border-destructive/30 px-3 py-1.5 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            {r.retry}
          </button>
        </div>
      ) : (
        <>
          {view && (
            <ResourceTierPicker
              key={id}
              value={view.tier}
              values={view.production}
              requiresLimit={requiresLimit}
              capacity={capacityKnown ? capacity : undefined}
              saving={saving}
              onSelect={save}
            />
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
