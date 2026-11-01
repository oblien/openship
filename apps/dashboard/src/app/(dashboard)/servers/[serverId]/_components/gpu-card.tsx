"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { useId, useState } from "react";
import { systemApi, type ServerInfo } from "@/lib/api/system";
import { getApiErrorMessage } from "@/lib/api/client";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { gpuMismatch } from "@/lib/server-gpu";
import { CustomSelect } from "@/components/ui/CustomSelect";

type Mode = "auto" | "yes" | "no";
const toMode = (o: "yes" | "no" | null | undefined): Mode => o ?? "auto";
const toOverride = (m: Mode): "yes" | "no" | null => (m === "auto" ? null : m);

/**
 * GPU status + manual mark for a server. Detection comes from the API (Docker `/info`); the mark is the
 * operator's override and wins over detection in both directions. Saving only sends `gpuOverride`, so
 * it never touches the connection settings.
 */
export function GpuCard({
  server,
  onChanged,
}: {
  server: ServerInfo;
  onChanged: (server: ServerInfo) => void;
}) {
  const { t } = useI18n();
  const s = t.servers.gpu;
  const { showToast } = useToast();
  const controlId = useId();
  const [mode, setMode] = useState<Mode>(toMode(server.gpu?.override));
  const [saving, setSaving] = useState(false);
  const gpu = server.gpu;
  if (!gpu) return null;

  const mismatch = gpuMismatch(gpu);
  const status = !gpu.probed
    ? s.notProbed
    : gpu.detected
      ? gpu.count === 1
        ? s.countOne
        : gpu.count
          ? interpolate(s.countMany, { count: String(gpu.count) })
          : s.runtimeOnly
      : s.notDetected;

  async function choose(next: Mode) {
    if (next === mode || saving) return;
    const before = mode;
    setMode(next);
    setSaving(true);
    try {
      const updated = await systemApi.updateServerEntry(server.id, {
        gpuOverride: toOverride(next),
      });
      onChanged(updated);
      showToast(s.saved, "success");
    } catch (err) {
      setMode(before);
      showToast(getApiErrorMessage(err, s.saveFailed), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-card rounded-2xl @container/gpu">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-border/50">
        <div className="flex min-w-0 items-center gap-3">
          <div className="w-9 h-9 bg-info/10 rounded-xl flex items-center justify-center">
            <UiIcon name="cpu" className="size-[18px] text-info" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground text-[15px]">{s.title}</h2>
            <p className="text-xs text-muted-foreground">{s.subtitle}</p>
          </div>
        </div>
        <span
          className={`rounded px-2 py-1 text-xs ${gpu.available ? "bg-success/10 text-success" : "bg-muted/50 text-muted-foreground"}`}
        >
          {status}
        </span>
      </div>
      <div className="space-y-3 px-5 py-4">
        <div className="flex flex-col gap-3 @min-[32rem]/gpu:flex-row @min-[32rem]/gpu:items-center @min-[32rem]/gpu:justify-between @min-[32rem]/gpu:gap-6">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <label htmlFor={controlId} className="text-sm font-medium text-foreground">
                {s.modeLabel}
              </label>
              {saving && (
                <span
                  role="status"
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <UiIcon name="spinner" className="size-3 motion-safe:animate-spin" />
                  {s.saving}
                </span>
              )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{s.modeHint}</p>
          </div>
          <div className="w-full shrink-0 @min-[32rem]/gpu:w-52">
            <CustomSelect<Mode>
              id={controlId}
              aria-label={s.modeLabel}
              value={mode}
              options={[
                { value: "auto", label: s.modeAuto },
                { value: "yes", label: s.modeYes },
                { value: "no", label: s.modeNo },
              ]}
              onChange={(next) => void choose(next)}
              disabled={saving}
              variant="filled"
              triggerClassName="bg-muted/60 hover:bg-muted"
            />
          </div>
        </div>
        {mismatch && (
          <p role="status" className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
            {mismatch === "yes-not-detected" ? s.mismatchYes : s.mismatchNo}
          </p>
        )}
      </div>
    </div>
  );
}
