"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect } from "react";
import { api } from "@/lib/api/client";
import { useI18n } from "@/components/i18n-provider";

/**
 * Shown in place of the dashboard while a migration is mid-flight.
 *
 * Force-reloading the page during cutover would either trigger a
 * write against a DB that's being moved (503) or land on the
 * `MigratedLauncher`, which falsely implies the migration is done.
 * This third variant says "hang tight" and polls `/api/health/env`
 * every 4s; once `migrationInProgress` flips back to `false`, it
 * reloads the page so the layout re-evaluates the gate and renders
 * whatever the final state is (normal UI on failure, MigratedLauncher
 * on success).
 *
 * Polling pauses while the tab is hidden so we don't waste cycles on
 * a backgrounded dashboard.
 */
export function MigrationInProgress() {
  const { t } = useI18n();
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const POLL_MS = 4000;

    const schedule = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return;
      timer = setTimeout(tick, POLL_MS);
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const data = await api.get<{ migrationInProgress?: boolean }>(
          "health/env",
        );
        if (data?.migrationInProgress === false) {
          window.location.reload();
          return;
        }
      } catch {
        // Network blip mid-cutover is expected — just keep polling.
      }
      schedule();
    };

    const onVisibility = () => {
      if (cancelled) return;
      if (document.hidden) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      } else if (!timer) {
        // Tab refocused — fire one immediately, then resume cadence.
        void tick();
      }
    };

    schedule();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, []);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-black p-8 text-white">
      <div className="w-full max-w-lg space-y-6 rounded-2xl border border-white/10 bg-white/[0.02] p-8">
        <div className="flex items-center gap-4">
          <UiIcon name="spinner" className="inline-block h-6 w-6 animate-spin text-white" aria-hidden="true" />
          <h1 className="text-2xl font-semibold">{t.chrome.migration.inProgressTitle}</h1>
        </div>

        <p className="text-sm text-white/60">
          {t.chrome.migration.inProgressBody}
        </p>

        <div className="space-y-1 border-t border-white/10 pt-6">
          <p className="text-xs text-white/40">
            {t.chrome.migration.inProgressHint}
          </p>
        </div>
      </div>
    </div>
  );
}
