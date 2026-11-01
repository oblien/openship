"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Switch-back page — reverse a team-mode migration and put this instance
 * back into single_user mode.
 *
 *   Path A (self_hosted_remote): SSH-pull the latest dump from the
 *                                operator's VPS, restore locally.
 *   Path B (cloud_hosted):       Pull the dump from api.openship.io.
 *   Path C (tunneled):           Tear down the Oblien tunnel (no data
 *                                move).
 *
 * The wizard's UI flow:
 *   1. Show what's about to happen (mode + remote URL + "teammates lose
 *      access" warning + the strippedEncryptedFields the operator will
 *      have to re-link).
 *   2. Optional "abandon remote" checkbox — skip the data pull and just
 *      flip the local mode back.
 *   3. On success show the strippedEncryptedFields summary and a "back
 *      to dashboard" CTA. We hard-reload so the launcher screen goes
 *      away and the normal dashboard takes over.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { migrationApi, api, getApiErrorMessage } from "@/lib/api";
import type { SwitchBackResult } from "@/lib/api/migration";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

type TeamMode =
  | "single_user"
  | "self_hosted_remote"
  | "cloud_hosted"
  | "tunneled";

interface InstanceState {
  teamMode: TeamMode;
  migrationTargetUrl: string | null;
}

export default function SwitchBackPage() {
  const router = useRouter();
  const { showToast } = useToast();
  const { t } = useI18n();
  const modeLabel = (mode: TeamMode) =>
    mode === "self_hosted_remote"
      ? t.settings.switchBack.modeServer
      : mode === "cloud_hosted"
        ? t.settings.switchBack.modeCloud
        : mode === "tunneled"
          ? t.settings.switchBack.modeTunnel
          : mode;
  const [state, setState] = useState<InstanceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [abandonRemote, setAbandonRemote] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SwitchBackResult | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<InstanceState & { invitationMailSource?: string }>("system/settings")
      .then((s) => {
        if (!alive) return;
        setState({
          teamMode: s.teamMode ?? "single_user",
          migrationTargetUrl: s.migrationTargetUrl ?? null,
        });
      })
      .catch((err) =>
        showToast(getApiErrorMessage(err, t.settings.switchBack.toastLoadStateFailed), "error", t.settings.common.toast.switchBack),
      )
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [showToast, t]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await migrationApi.switchBack({ abandonRemote });
      setResult(res);
    } catch (err: unknown) {
      const apiErr = err as { status?: number };
      if (apiErr.status === 502 && !abandonRemote) {
        showToast(
          t.settings.switchBack.toastRemoteUnreachable,
          "error",
          t.settings.common.toast.switchBack,
        );
      } else {
        showToast(getApiErrorMessage(err, t.settings.switchBack.toastSwitchBackFailed), "error", t.settings.common.toast.switchBack);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <UiIcon name="spinner" className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!state || state.teamMode === "single_user") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <div className="max-w-md space-y-4 text-center">
          <div className="mx-auto size-12 rounded-2xl bg-muted/40 flex items-center justify-center">
            <UiIcon name="check-circle" className="size-6 text-success" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              {t.settings.switchBack.nothingTitle}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t.settings.switchBack.nothingBody}
            </p>
          </div>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t.settings.switchBack.openDashboard}
          </button>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <div className="w-full max-w-lg space-y-5 rounded-2xl border border-border/50 bg-card p-6">
          <div className="flex items-start gap-3">
            <UiIcon name="check-circle" className="size-6 text-success shrink-0 mt-0.5" />
            <div>
              <h1 className="text-xl font-semibold text-foreground">
                {t.settings.switchBack.resultTitle}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                {result.syncedFromRemote
                  ? interpolate(t.settings.switchBack.resultRestored, { rows: result.rowsRestored.toLocaleString(), mode: result.previousMode })
                  : result.previousMode === "tunneled"
                    ? t.settings.switchBack.resultLocalTunnel
                    : t.settings.switchBack.resultLocalGrace}
              </p>
            </div>
          </div>

          {result.strippedEncryptedFields.length > 0 && (
            <div className="rounded-xl border border-warning-border bg-warning-bg p-4 space-y-2">
              <div className="flex items-center gap-2 text-warning">
                <UiIcon name="warning" className="size-4" />
                <p className="text-sm font-medium">{t.settings.switchBack.relinkTitle}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                {t.settings.switchBack.relinkBody}
              </p>
              <ul className="space-y-1 text-xs">
                {result.strippedEncryptedFields.map((f) => (
                  <li key={`${f.table}.${f.column}`} className="font-mono text-muted-foreground">
                    {interpolate(
                      f.rowsAffected === 1 ? t.settings.switchBack.relinkRowOne : t.settings.switchBack.relinkRowMany,
                      { table: f.table, column: f.column, rows: String(f.rowsAffected) },
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              if (typeof window !== "undefined") window.location.assign("/");
            }}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t.settings.switchBack.openDashboard}
          </button>
        </div>
      </div>
    );
  }

  const isTunnel = state.teamMode === "tunneled";

  return (
    <div className="flex min-h-dvh items-start justify-center bg-background p-6">
      <div className="w-full max-w-lg mt-12 space-y-5">
        <button
          type="button"
          onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <UiIcon name="chevron-left" className="size-4 rtl:rotate-180" />
          {t.settings.switchBack.back}
        </button>

        <div className="rounded-2xl border border-border/50 bg-card p-6 space-y-5">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-warning-bg text-warning flex items-center justify-center shrink-0">
              <UiIcon name="rotate-left" className="size-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-foreground">
                {t.settings.switchBack.heading}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                {interpolate(t.settings.switchBack.intro, { mode: modeLabel(state.teamMode) })}
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-border/50 px-4 py-3 space-y-1">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {t.settings.switchBack.current}
            </p>
            <p className="text-sm font-mono text-foreground break-all">
              {state.migrationTargetUrl ?? t.settings.switchBack.noUrl}
            </p>
          </div>

          <div className="rounded-xl border border-destructive/30 bg-destructive/[0.04] p-4 space-y-2">
            <div className="flex items-center gap-2 text-destructive">
              <UiIcon name="warning" className="size-4" />
              <p className="text-sm font-medium">{t.settings.switchBack.teammatesLoseAccess}</p>
            </div>
            <p className="text-xs text-muted-foreground">
              {isTunnel
                ? t.settings.switchBack.warnTunnel
                : t.settings.switchBack.warnRemote}
            </p>
          </div>

          {!isTunnel && (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={abandonRemote}
                onChange={(e) => setAbandonRemote(e.target.checked)}
                disabled={submitting}
                className="mt-0.5"
              />
              <span className="text-sm text-foreground">
                {t.settings.switchBack.dontPull}
                <span className="block text-xs text-muted-foreground mt-0.5">
                  {t.settings.switchBack.dontPullDesc}
                </span>
              </span>
            </label>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => router.back()}
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {t.settings.common.cancel}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="inline-flex items-center gap-2 px-4 py-2 bg-destructive text-destructive-foreground rounded-xl text-sm font-medium hover:bg-destructive/90 disabled:opacity-50"
            >
              {submitting && <UiIcon name="spinner" className="size-4 animate-spin" />}
              {submitting
                ? isTunnel
                  ? t.settings.switchBack.tearingDown
                  : t.settings.switchBack.pullingData
                : t.settings.switchBack.switchBack}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function labelFor(mode: TeamMode): string {
  switch (mode) {
    case "self_hosted_remote":
      return "your server";
    case "cloud_hosted":
      return "Openship Cloud";
    case "tunneled":
      return "the tunnel";
    default:
      return mode;
  }
}
