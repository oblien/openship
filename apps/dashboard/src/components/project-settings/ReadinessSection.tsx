"use client";

/**
 * The deploy-time readiness gate, as one collapsed-by-default section.
 *
 * Shared by the deploy wizard and a project's Advanced settings so the form
 * exists once. Presentational: it owns no persistence, only `value`/`onChange`.
 *
 * COLLAPSED AND OFF BY DEFAULT, deliberately. These checks used to be hardcoded
 * on every deploy — up to a minute of post-start waiting that could fail a deploy
 * whose container was running fine, and then delete it. They are now something you
 * opt into when you want the deploy itself to refuse to go green. `undefined`
 * means off, so a project that never opens this section sends nothing.
 */

import React, { useState } from "react";
import { Activity, ChevronDown, ChevronUp } from "lucide-react";
import { Toggle } from "@/components/project-settings/ServerSideSwitch";
import { useI18n } from "@/components/i18n-provider";
import type { OpenshipReadiness } from "@repo/core";

interface Props {
  value: OpenshipReadiness | null | undefined;
  onChange: (next: OpenshipReadiness | undefined) => void;
  /** Render open on mount. Defaults to closed — see the module note. */
  defaultOpen?: boolean;
  disabled?: boolean;
  /**
   * Drop this component's own header + collapse and render just the fields, for a
   * host that already provides them (project settings nests it in a collapsed
   * SectionCard — two levels of collapse would be one click too many).
   */
  embedded?: boolean;
}

/** Defaults mirrored from SYSTEM.DEPLOYMENTS, shown as placeholders not values. */
const DEFAULT_TIMEOUT_SECONDS = 45;
const DEFAULT_STABILIZATION_SECONDS = 15;

const ReadinessSection: React.FC<Props> = ({
  value,
  onChange,
  defaultOpen = false,
  disabled = false,
  embedded = false,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const { t } = useI18n();
  const hc = t.importProject.buildSettings.healthCheck;

  const probeOn = value?.enabled === true;
  const stabilizationOn = value?.stabilization === true;
  const anyOn = probeOn || stabilizationOn;

  /**
   * Merge a patch, and collapse "nothing is on any more" back to `undefined` so
   * turning both toggles off is indistinguishable from never having touched the
   * section. Without this an all-false object would persist and read as "configured".
   */
  const patch = (next: Partial<OpenshipReadiness>) => {
    const merged: OpenshipReadiness = { ...(value ?? {}), ...next };
    if (merged.enabled !== true && merged.stabilization !== true) {
      onChange(undefined);
      return;
    }
    onChange(merged);
  };

  const numberField = (
    label: string,
    current: number | undefined,
    fallback: number,
    onCommit: (n: number | undefined) => void,
  ) => (
    <div>
      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{label}</label>
      <input
        type="number"
        min={1}
        max={600}
        disabled={disabled}
        value={current ?? ""}
        placeholder={String(fallback)}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return onCommit(undefined);
          const n = Number(raw);
          onCommit(Number.isFinite(n) && n > 0 ? Math.min(600, Math.round(n)) : undefined);
        }}
        className="w-full px-3.5 py-2.5 bg-muted/30 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
      />
    </div>
  );

  const body = (
        <div
          className={
            embedded
              ? "space-y-4"
              : "px-5 pb-5 border-t border-border/50 pt-4 space-y-4"
          }
        >
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">{hc.description}</p>

          {/* ── Readiness probe ─────────────────────────────── */}
          <div className="space-y-3 rounded-xl border border-border/50 bg-muted/30 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{hc.probeLabel}</p>
                <p className="text-[11px] text-muted-foreground/70 leading-relaxed">{hc.probeDesc}</p>
              </div>
              <Toggle
                checked={probeOn}
                disabled={disabled}
                aria-label={hc.probeLabel}
                onChange={(v: boolean) => patch({ enabled: v })}
              />
            </div>
            {probeOn && (
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{hc.pathLabel}</label>
                  <input
                    type="text"
                    disabled={disabled}
                    value={value?.path ?? ""}
                    placeholder={hc.pathPlaceholder}
                    onChange={(e) => patch({ path: e.target.value.trim() || undefined })}
                    className="w-full px-3.5 py-2.5 bg-background border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                  />
                  <p className="text-[11px] text-muted-foreground/70 mt-1.5 leading-relaxed">
                    {hc.pathDesc}
                  </p>
                </div>
                {numberField(
                  hc.timeoutLabel,
                  value?.timeoutSeconds,
                  DEFAULT_TIMEOUT_SECONDS,
                  (n) => patch({ timeoutSeconds: n }),
                )}
              </div>
            )}
          </div>

          {/* ── Stabilization watch ─────────────────────────── */}
          <div className="space-y-3 rounded-xl border border-border/50 bg-muted/30 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{hc.stabilizationLabel}</p>
                <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                  {hc.stabilizationDesc}
                </p>
              </div>
              <Toggle
                checked={stabilizationOn}
                disabled={disabled}
                aria-label={hc.stabilizationLabel}
                onChange={(v: boolean) => patch({ stabilization: v })}
              />
            </div>
            {stabilizationOn && (
              <div className="grid sm:grid-cols-2 gap-3">
                {numberField(
                  hc.stabilizationWindowLabel,
                  value?.stabilizationSeconds,
                  DEFAULT_STABILIZATION_SECONDS,
                  (n) => patch({ stabilizationSeconds: n }),
                )}
              </div>
            )}
          </div>

          {/* Only meaningful once something can fail. */}
          {anyOn && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                {hc.onFailureLabel}
              </label>
              <select
                disabled={disabled}
                value={value?.onFailure ?? "warn"}
                onChange={(e) => patch({ onFailure: e.target.value === "fail" ? "fail" : "warn" })}
                className="w-full px-3.5 py-2.5 bg-muted/30 border border-border/50 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
              >
                <option value="warn">{hc.onFailureWarn}</option>
                <option value="fail">{hc.onFailureFail}</option>
              </select>
            </div>
          )}
        </div>
  );

  if (embedded) return body;

  // Same card as ComposePathField, including its two-state treatment: prominent
  // (bg-card, tinted icon chip, semibold title) once a gate is configured,
  // demoted (bg-muted/20, grey chip, medium title) while it's off. Off IS the
  // default here, so the demoted state is the honest one — this is an opt-in
  // affordance, not a detected fact, exactly like an unpinned compose path.
  return (
    <div className={`rounded-2xl border border-border/50 ${anyOn ? "bg-card" : "bg-muted/20"}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 text-start"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`flex items-center justify-center rounded-xl shrink-0 ${
              anyOn ? "w-9 h-9 bg-info/10" : "w-8 h-8 bg-muted/60"
            }`}
          >
            <Activity
              className={anyOn ? "size-[18px] text-info" : "size-4 text-muted-foreground"}
            />
          </div>
          <div className="min-w-0">
            <p
              className={
                anyOn
                  ? "text-[15px] font-semibold text-foreground"
                  : "text-sm font-medium text-muted-foreground"
              }
            >
              {hc.title}
            </p>
            <p className="text-sm text-muted-foreground">
              {anyOn ? hc.subtitleOn : hc.subtitle}
            </p>
          </div>
        </div>
        {open ? (
          <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && body}
    </div>
  );
};

export default React.memo(ReadinessSection);
