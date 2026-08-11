"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Loader2, Check, ArrowUpCircle } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { updatesApi, type UpdateStatusItem } from "@/lib/api/updates";
import { getApiErrorMessage } from "@/lib/api/client";
import { AppLogo } from "@/components/AppLogo";

/**
 * Source view for a release/image APP (self-app, n8n, Convex, webmail…). These
 * deploy from a GitHub release or a registry tag — NOT a git repo you push to —
 * so instead of the git-link/webhook UI they show a read-only "release source"
 * with the current + latest version and an Update action. Reuses the unified
 * update system (updatesApi list/scan/apply); no separate detection here.
 */
export function AppSource() {
  const { id, projectData } = useProjectSettings();
  const { t } = useI18n();
  const s = t.projectSettings.appSource;
  const { showToast } = useToast();
  const router = useRouter();

  const [status, setStatus] = useState<UpdateStatusItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await updatesApi.list();
      setStatus((res.data ?? []).find((u) => u.projectId === String(id)) ?? null);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const checkNow = async () => {
    setChecking(true);
    try {
      await updatesApi.scan();
      await load();
    } catch (e) {
      showToast(getApiErrorMessage(e, s.checkFailed), "error", s.toastTitle);
    } finally {
      setChecking(false);
    }
  };

  const applyUpdate = async () => {
    setApplying(true);
    try {
      const res = await updatesApi.apply(String(id));
      const depId = res.data?.deployment_id;
      if (depId) {
        router.push(`/build/${depId}`);
        return;
      }
      await load();
      setApplying(false);
    } catch (e) {
      showToast(getApiErrorMessage(e, s.updateFailed), "error", s.toastTitle);
      setApplying(false);
    }
  };

  const hasData = !!status; // false until a scan has populated this project
  const kind = status?.kind ?? "release";
  const current = status?.currentLabel ?? projectData.version ?? "—";
  const latest = status?.latestLabel ?? null;
  const behind = !!status?.behind;
  const inProgress = !!status?.latestInProgress;
  const kindLabel = kind === "image" ? s.kindImage : s.kindRelease;

  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      <div className="flex items-center gap-3 border-b border-border/50 px-5 py-4">
        <div className="flex size-9 items-center justify-center rounded-xl bg-muted/60">
          <AppLogo appId={projectData.appTemplateId ?? undefined} className="size-[18px]" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{s.title}</h3>
          <p className="text-xs text-muted-foreground">{s.description}</p>
        </div>
      </div>

      <div className="px-5 py-1">
        <Row label={s.sourceType} value={kindLabel} />
        <Row label={s.current} value={current} mono />
        <Row
          label={s.latest}
          value={loading ? "…" : !hasData ? s.notChecked : latest ?? s.upToDate}
          mono={hasData && !!latest}
          badge={behind ? s.updateAvailable : undefined}
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border/50 px-5 py-4">
        <button
          type="button"
          onClick={checkNow}
          disabled={checking}
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
        >
          {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {s.checkForUpdates}
        </button>

        {inProgress ? (
          <span className="text-xs text-muted-foreground">{s.updating}</span>
        ) : behind ? (
          <button
            type="button"
            onClick={applyUpdate}
            disabled={applying}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {applying ? <Loader2 className="size-4 animate-spin" /> : <ArrowUpCircle className="size-4" />}
            {latest ? interpolate(s.updateTo, { version: latest }) : s.update}
          </button>
        ) : (
          hasData &&
          !loading && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
              <Check className="size-3.5" /> {s.upToDate}
            </span>
          )
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  badge,
}: {
  label: string;
  value: string;
  mono?: boolean;
  badge?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/40 py-3 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2">
        {badge && (
          <span className="rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-medium text-warning">
            {badge}
          </span>
        )}
        <span className={`text-sm font-medium text-foreground ${mono ? "font-mono" : ""}`}>{value}</span>
      </span>
    </div>
  );
}
