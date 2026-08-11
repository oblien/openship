"use client";

/**
 * Settings → Updates. Update/advisory status + user controls, for the desktop
 * app and self-hosted servers. Security posture is explicit: auto-update is OFF
 * by default, notifications can be muted, and everything is pulled from GitHub
 * only (see the disclosure) — nothing pushes to the install.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, Download, Github, CheckCircle2, Loader2 } from "lucide-react";
import { changelogUrl } from "@repo/core";
import { SettingsSection } from "./SettingsSection";
import { SettingsToggleRow } from "./SettingsToggleRow";
import { useUpdates } from "@/components/updates/useUpdates";
import CopyCommand, { SELF_UPDATE_COMMAND } from "@/components/shared/CopyCommand";
import { useI18n, interpolate } from "@/components/i18n-provider";

export function UpdatesTab() {
  const { t } = useI18n();
  const { state, muted, desktop, mode, setMuted, startDesktopUpdate, refresh } = useUpdates();
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    void window.desktop?.config
      ?.get<boolean | undefined>("autoUpdate")
      .then((v) => setAutoUpdate(v === true))
      .catch(() => {});
  }, [desktop]);

  const toggleAuto = useCallback((v: boolean) => {
    setAutoUpdate(v);
    void window.desktop?.config?.set("autoUpdate", v);
  }, []);

  const checkNow = useCallback(() => {
    setChecking(true);
    refresh();
    setTimeout(() => setChecking(false), 1200);
  }, [refresh]);

  const upToDate = state && !state.updateAvailable;

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={RefreshCw}
        title={t.settings.updates.title}
        description={t.settings.updates.description}
      >
        {/* Status */}
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border/50 bg-background px-4 py-3">
          <div className="flex items-center gap-3">
            <div className={`flex size-9 items-center justify-center rounded-xl ${upToDate ? "bg-success-bg text-success" : "bg-primary/10 text-primary"}`}>
              {upToDate ? <CheckCircle2 className="size-[18px]" /> : <Download className="size-[18px]" />}
            </div>
            <div>
              <p className="text-[14px] font-medium text-foreground">
                {!state
                  ? t.settings.updates.checking
                  : state.updateAvailable
                    ? interpolate(t.settings.updates.available, { version: state.latestVersion ?? "" })
                    : t.settings.updates.upToDate}
              </p>
              <p className="text-[12px] text-muted-foreground">
                {state?.currentVersion ? interpolate(t.settings.updates.current, { version: state.currentVersion }) : ""}
                {state?.updateAvailable && !desktop ? t.settings.updates.rerunToUpdate : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Self-hosted: the upgrade runs on the host, so hand over the exact
                command. The line above only said "re-run your install". */}
            {state?.updateAvailable && mode === "selfhosted" && (
              <CopyCommand command={SELF_UPDATE_COMMAND} />
            )}
            {state?.updateAvailable && desktop && (
              <button
                type="button"
                onClick={startDesktopUpdate}
                className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
              >
                <Download className="size-3.5" />
                {t.settings.updates.updateNow}
              </button>
            )}
            <button
              type="button"
              onClick={checkNow}
              disabled={checking}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-60"
            >
              {checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {t.settings.updates.checkNow}
            </button>
          </div>
        </div>

        {/* Controls */}
        <div className="mt-5 space-y-4">
          {desktop && (
            <SettingsToggleRow
              checked={autoUpdate}
              onChange={toggleAuto}
              label={t.settings.updates.autoUpdateLabel}
              description={t.settings.updates.autoUpdateDesc}
            />
          )}
          <SettingsToggleRow
            checked={!muted}
            onChange={(v) => setMuted(!v)}
            label={t.settings.updates.notificationsLabel}
            description={t.settings.updates.notificationsDesc}
          />
        </div>

        <a
          href={changelogUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground underline-offset-4 hover:underline"
        >
          <Github className="size-3.5" />
          {t.settings.updates.viewChangelog}
        </a>
      </SettingsSection>

      {/* Security disclosure */}
      <SettingsSection
        icon={ShieldCheck}
        title={t.settings.updates.securityTitle}
        description={t.settings.updates.securityDescription}
        iconBg="bg-success-bg"
        iconColor="text-success"
      >
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          {t.settings.updates.security1} <span className="font-medium text-foreground">{t.settings.updates.securityOnlyGithub}</span> {t.settings.updates.security2}
          <a href="https://github.com/oblien/openship" target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4">
            github.com/oblien/openship
          </a>
          {t.settings.updates.security3} <span className="font-medium text-foreground">{t.settings.updates.securityPulls}</span> {t.settings.updates.security4}
        </p>
      </SettingsSection>
    </div>
  );
}
