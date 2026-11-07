"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { useId, useState } from "react";
import { systemApi, type ServerInfo } from "@/lib/api/system";
import { getApiErrorMessage } from "@/lib/api/client";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BUILD_CACHE_BUDGET_MAX_GIB,
  BUILD_CACHE_BUDGET_MIN_GIB,
  budgetBytesToGib,
  parseBudgetGib,
} from "@/lib/server-build-cache";

type Mode = "auto" | "custom";

/**
 * Managed build-cache budget for a server. Automatic keeps a share of the server's Docker disk;
 * a custom budget replaces it. Saving only sends `buildCacheBudgetBytes`, so it never touches the
 * connection settings, and the next build on the server uses the new value.
 */
export function BuildCacheCard({
  server,
  onChanged,
}: {
  server: ServerInfo;
  onChanged: (server: ServerInfo) => void;
}) {
  const { t } = useI18n();
  const s = t.servers.buildCache;
  const { showToast } = useToast();
  const modeId = useId();
  const sizeId = useId();
  const stored = server.buildCacheBudgetBytes ?? null;
  const [mode, setMode] = useState<Mode>(stored === null ? "auto" : "custom");
  const [size, setSize] = useState(budgetBytesToGib(stored));
  const [saving, setSaving] = useState(false);
  if (server.buildCacheBudgetBytes === undefined) return null;

  const parsed = parseBudgetGib(size);
  // Compare as displayed too: a budget set through the API is shown rounded to two decimals.
  const unchanged = mode === "custom" && (parsed === stored || size === budgetBytesToGib(stored));
  const status =
    stored === null
      ? s.statusAuto
      : interpolate(s.statusCustom, { size: budgetBytesToGib(stored) });

  async function save(budget: number | null, revert: () => void) {
    setSaving(true);
    try {
      const updated = await systemApi.updateServerEntry(server.id, {
        buildCacheBudgetBytes: budget,
      });
      onChanged(updated);
      showToast(s.saved, "success");
    } catch (err) {
      revert();
      showToast(getApiErrorMessage(err, s.saveFailed), "error");
    } finally {
      setSaving(false);
    }
  }

  function choose(next: Mode) {
    if (next === mode || saving) return;
    const before = mode;
    setMode(next);
    // Automatic needs no value, so it saves straight away; custom waits for a size and Save.
    if (next === "auto" && stored !== null) void save(null, () => setMode(before));
  }

  return (
    <div className="bg-card rounded-2xl @container/cache">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-border/50">
        <div className="flex min-w-0 items-center gap-3">
          <div className="w-9 h-9 bg-info/10 rounded-xl flex items-center justify-center">
            <UiIcon name="database" className="size-[18px] text-info" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground text-[15px]">{s.title}</h2>
            <p className="text-xs text-muted-foreground">{s.subtitle}</p>
          </div>
        </div>
        <span className="rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
          {status}
        </span>
      </div>
      <div className="space-y-3 px-5 py-4">
        <div className="flex flex-col gap-3 @min-[32rem]/cache:flex-row @min-[32rem]/cache:items-center @min-[32rem]/cache:justify-between @min-[32rem]/cache:gap-6">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <label htmlFor={modeId} className="text-sm font-medium text-foreground">
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
          <div className="w-full shrink-0 @min-[32rem]/cache:w-52">
            <CustomSelect<Mode>
              id={modeId}
              aria-label={s.modeLabel}
              value={mode}
              options={[
                { value: "auto", label: s.modeAuto },
                { value: "custom", label: s.modeCustom },
              ]}
              onChange={choose}
              disabled={saving}
              variant="filled"
              triggerClassName="bg-muted/60 hover:bg-muted"
            />
          </div>
        </div>
        {mode === "custom" && (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (parsed !== null && !unchanged)
                void save(parsed, () => setSize(budgetBytesToGib(stored)));
            }}
          >
            <div className="min-w-0 flex-1 space-y-1">
              <label htmlFor={sizeId} className="text-xs font-medium text-foreground">
                {s.customLabel}
              </label>
              <Input
                id={sizeId}
                inputMode="decimal"
                value={size}
                onChange={(event) => setSize(event.target.value)}
                disabled={saving}
                aria-invalid={size !== "" && parsed === null}
                aria-describedby={size !== "" && parsed === null ? `${sizeId}-error` : undefined}
              />
            </div>
            <Button type="submit" className="h-11" disabled={saving || parsed === null || unchanged}>
              {s.save}
            </Button>
            {size !== "" && parsed === null && (
              <p id={`${sizeId}-error`} role="alert" className="w-full text-xs text-danger">
                {interpolate(s.invalid, {
                  min: String(BUILD_CACHE_BUDGET_MIN_GIB),
                  max: String(BUILD_CACHE_BUDGET_MAX_GIB),
                })}
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
