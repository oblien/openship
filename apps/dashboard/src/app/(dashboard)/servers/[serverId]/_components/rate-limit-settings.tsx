"use client";

import { useState, useEffect, useCallback } from "react";
import { Shield, Plus, X, Loader2, Check, RefreshCw } from "lucide-react";
import { systemApi, type ServerRateLimitConfig } from "@/lib/api/system";
import { getApiErrorMessage } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getAutoBurst(rps: number): number {
  if (rps <= 0) {
    return 0;
  }

  return Math.max(1, Math.round(rps * 0.4));
}

export function RateLimitSettings({ serverId }: { serverId: string }) {
  const { showToast } = useToast();
  const { t } = useI18n();

  const formatPolicySummary = (config: ServerRateLimitConfig): string => {
    const base = interpolate(t.servers.security.policyBase, {
      rps: String(config.rps),
      burst: String(config.burst),
    });
    if (config.whitelist.length === 0) {
      return base;
    }
    return interpolate(t.servers.security.policyWhitelisted, {
      base,
      count: String(config.whitelist.length),
    });
  };

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentConfig, setCurrentConfig] = useState<ServerRateLimitConfig | null>(null);
  const [isEditing, setIsEditing] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [useAutomaticBurst, setUseAutomaticBurst] = useState(true);
  const [draftRps, setDraftRps] = useState(50);
  const [draftBurst, setDraftBurst] = useState(20);
  const [draftWhitelist, setDraftWhitelist] = useState<string[]>([]);
  const [newIp, setNewIp] = useState("");

  const syncDraftFromConfig = useCallback((config: ServerRateLimitConfig) => {
    const autoBurst = getAutoBurst(config.rps);
    setDraftRps(config.rps);
    setDraftBurst(config.burst);
    setDraftWhitelist(config.whitelist);
    setUseAutomaticBurst(config.burst === autoBurst);
    setShowAdvanced(false);
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const res = await systemApi.getRateLimit(serverId);
      // Validate the shape before it reaches state. A 2xx whose body isn't the
      // config we asked for (a proxy answering for the API, a version skew) used
      // to be stored as-is; the derived reads below then threw DURING RENDER, and
      // this card is mounted by the server page — so one malformed response took
      // the whole page to the error boundary and, with it, the only "Remove
      // server" action there is. A bad payload is a load error, not a crash.
      const config = res?.config;
      if (
        !config ||
        typeof config.rps !== "number" ||
        typeof config.burst !== "number" ||
        !Array.isArray(config.whitelist)
      ) {
        setCurrentConfig(null);
        setLoadError(t.servers.security.failedReadConfig);
        return;
      }
      setCurrentConfig(config);
      syncDraftFromConfig(config);
      setIsEditing(config.rps === 0);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t.servers.security.failedReadConfig);
    } finally {
      setLoading(false);
    }
  }, [serverId, syncDraftFromConfig, t]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  // `!= null`, not `!== null`: these run on every render, BEFORE the
  // `!currentConfig` bail-out below, so a nullish config has to read as absent
  // here or the property access throws mid-render and the page dies.
  const hasExistingLimit = currentConfig != null && currentConfig.rps > 0;
  const effectiveBurst = useAutomaticBurst ? getAutoBurst(draftRps) : draftBurst;

  const hasChanges = currentConfig != null && (
    draftRps !== currentConfig.rps ||
    effectiveBurst !== currentConfig.burst ||
    !arraysEqual(draftWhitelist, currentConfig.whitelist)
  );

  const handleRpsChange = (value: string) => {
    const nextRps = Math.max(0, Number.parseInt(value, 10) || 0);
    setDraftRps(nextRps);
    if (useAutomaticBurst) {
      setDraftBurst(getAutoBurst(nextRps));
    }
  };

  const handleStartEditing = () => {
    if (!currentConfig) {
      return;
    }

    syncDraftFromConfig(currentConfig);
    setIsEditing(true);
  };

  const handleCancelEditing = () => {
    if (!currentConfig) {
      return;
    }

    syncDraftFromConfig(currentConfig);
    setIsEditing(currentConfig.rps === 0);
    setNewIp("");
  };

  const handleToggleAutomaticBurst = () => {
    if (useAutomaticBurst) {
      setUseAutomaticBurst(false);
      setShowAdvanced(true);
      return;
    }

    const nextBurst = getAutoBurst(draftRps);
    setUseAutomaticBurst(true);
    setDraftBurst(nextBurst);
  };

  const handleSave = async () => {
    if (!currentConfig || !hasChanges) {
      return;
    }

    setSaving(true);
    try {
      const previousSummary = formatPolicySummary(currentConfig);
      const nextDraft = {
        rps: draftRps,
        burst: effectiveBurst,
        whitelist: draftWhitelist,
      };
      const res = await systemApi.updateRateLimit(serverId, {
        rps: nextDraft.rps,
        burst: nextDraft.burst,
        whitelist: nextDraft.whitelist,
      });

      if (res.success) {
        setCurrentConfig(res.config);
        syncDraftFromConfig(res.config);
        setIsEditing(res.config.rps === 0);
        setNewIp("");
        showToast(
          interpolate(t.servers.security.toastRateLimitUpdated, {
            from: previousSummary,
            to: formatPolicySummary(res.config),
          }),
          "success",
          t.servers.toastTitles.security,
        );
      } else {
        showToast(res.error || t.servers.security.toastFailedApply, "error", t.servers.toastTitles.security);
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, t.servers.security.toastFailedSave), "error", t.servers.toastTitles.security);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!currentConfig || currentConfig.rps === 0) {
      return;
    }

    setSaving(true);
    try {
      const res = await systemApi.updateRateLimit(serverId, {
        rps: 0,
        burst: 0,
        whitelist: [],
      });

      if (res.success) {
        setCurrentConfig(res.config);
        syncDraftFromConfig(res.config);
        setIsEditing(true);
        setNewIp("");
        showToast(t.servers.security.toastRemoved, "success", t.servers.toastTitles.security);
      } else {
        showToast(res.error || t.servers.security.toastFailedRemove, "error", t.servers.toastTitles.security);
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, t.servers.security.toastFailedRemove), "error", t.servers.toastTitles.security);
    } finally {
      setSaving(false);
    }
  };

  const addIp = () => {
    const cidr = newIp.trim();
    if (!cidr) return;
    const normalized = cidr.includes("/") ? cidr : `${cidr}/32`;
    if (!/^[\da-fA-F.:]+\/\d{1,3}$/.test(normalized)) {
      showToast(t.servers.security.toastInvalidIp, "error");
      return;
    }
    if (draftWhitelist.includes(normalized)) {
      showToast(t.servers.security.toastAlreadyWhitelisted, "error");
      return;
    }
    setDraftWhitelist([...draftWhitelist, normalized]);
    setNewIp("");
  };

  const removeIp = (cidr: string) => {
    setDraftWhitelist(draftWhitelist.filter((ip) => ip !== cidr));
  };

  const resetDraft = () => {
    if (!currentConfig) return;
    syncDraftFromConfig(currentConfig);
    setNewIp("");
  };

  if (loading) {
    return (
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border/50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-orange-500/10 rounded-xl flex items-center justify-center">
              <Shield className="size-[18px] text-orange-500" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground text-[15px]">{t.servers.security.title}</h2>
              <p className="text-xs text-muted-foreground">{t.servers.security.subtitle}</p>
            </div>
          </div>
        </div>
        <div className="p-5 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t.servers.security.loading}
        </div>
      </div>
    );
  }

  if (loadError || !currentConfig) {
    return (
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border/50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-orange-500/10 rounded-xl flex items-center justify-center">
              <Shield className="size-[18px] text-orange-500" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground text-[15px]">{t.servers.security.title}</h2>
              <p className="text-xs text-muted-foreground">{t.servers.security.subtitle}</p>
            </div>
          </div>
        </div>
        <div className="p-5">
          <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t.servers.security.couldntRead}</p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {t.servers.security.retryHint}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void fetchConfig()}
              className="inline-flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
            >
              <RefreshCw className="size-3.5" />
              {t.servers.security.retry}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border/50">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-orange-500/10 rounded-xl flex items-center justify-center">
            <Shield className="size-[18px] text-orange-500" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground text-[15px]">{t.servers.security.title}</h2>
            <p className="text-xs text-muted-foreground">{t.servers.security.subtitle}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void fetchConfig()}
          className="inline-flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
        >
          <RefreshCw className="size-3.5" />
          {t.servers.security.refresh}
        </button>
      </div>
      <div className="p-5 space-y-5">
        {hasExistingLimit && !isEditing ? (
          <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">{formatPolicySummary(currentConfig)}</p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {t.servers.security.loadedFromLive}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleStartEditing}
                className="inline-flex items-center rounded-lg bg-background px-3 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
              >
                {t.servers.security.edit}
              </button>
              <button
                type="button"
                onClick={handleRemove}
                disabled={saving}
                className="inline-flex items-center rounded-lg px-3 py-2 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t.servers.security.remove}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <p className="text-[12px] text-muted-foreground">
                {hasExistingLimit
                  ? t.servers.security.editLiveHint
                  : t.servers.security.noLimitHint}
              </p>
              <div className="flex items-center gap-2">
                {hasChanges && (
                  <button
                    type="button"
                    onClick={resetDraft}
                    className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {t.servers.security.resetDraft}
                  </button>
                )}
                {hasExistingLimit && (
                  <button
                    type="button"
                    onClick={handleCancelEditing}
                    className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {t.servers.security.cancel}
                  </button>
                )}
              </div>
            </div>

            <div>
              <label className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">
                {t.servers.security.requestsPerSecond}
              </label>
              <input
                type="number"
                min={0}
                value={draftRps}
                onChange={(e) => handleRpsChange(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-[13px] text-foreground outline-none transition-colors focus:border-primary/50"
              />
              <p className="mt-1 text-sm text-muted-foreground">
                {useAutomaticBurst
                  ? interpolate(t.servers.security.burstAuto, { burst: String(effectiveBurst) })
                  : interpolate(t.servers.security.burstCustom, { burst: String(draftBurst) })}
              </p>
            </div>

            <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{t.servers.security.advanced}</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    {t.servers.security.advancedHint}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced((value) => !value)}
                  className="rounded-lg bg-background px-3 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
                >
                  {showAdvanced ? t.servers.security.hideAdvanced : t.servers.security.showAdvanced}
                </button>
              </div>

              {showAdvanced && (
                <div className="mt-4 space-y-4 border-t border-border/40 pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[12px] font-medium text-foreground">{t.servers.security.burstMode}</p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {t.servers.security.burstModeHint}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleToggleAutomaticBurst}
                      className="rounded-lg bg-background px-3 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      {useAutomaticBurst ? t.servers.security.switchToManual : t.servers.security.useAutomaticBurst}
                    </button>
                  </div>

                  <div>
                    <label className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">
                      {t.servers.security.burstAllowance}
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={useAutomaticBurst ? effectiveBurst : draftBurst}
                      disabled={useAutomaticBurst}
                      onChange={(e) => setDraftBurst(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                      className="mt-1.5 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-[13px] text-foreground outline-none transition-colors focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t.servers.security.burstAllowanceHint}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">
                {t.servers.security.whitelistedIps}
              </label>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {t.servers.security.whitelistHint}
              </p>

              {draftWhitelist.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {draftWhitelist.map((cidr) => (
                    <span
                      key={cidr}
                      className="inline-flex items-center gap-1 rounded-lg bg-muted/50 px-2.5 py-1 text-[12px] font-medium text-foreground"
                    >
                      {cidr}
                      <button
                        type="button"
                        onClick={() => removeIp(cidr)}
                        className="ms-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  value={newIp}
                  onChange={(e) => setNewIp(e.target.value)}
                  placeholder={t.servers.security.ipPlaceholder}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addIp())}
                  className="flex-1 rounded-lg border border-border/60 bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors focus:border-primary/50"
                />
                <button
                  type="button"
                  onClick={addIp}
                  className="inline-flex items-center gap-1 rounded-lg bg-muted/50 px-3 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <Plus className="size-3.5" />
                  {t.servers.security.add}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-border/40 pt-4">
              <div className="flex items-center gap-2 text-[12px]">
                <span
                  className={`inline-block size-2 rounded-full ${
                    hasChanges ? "bg-warning-solid" : "bg-muted-foreground/40"
                  }`}
                />
                <span className="text-muted-foreground">
                  {hasChanges
                    ? interpolate(t.servers.security.draftChanges, {
                        summary: formatPolicySummary({ rps: draftRps, burst: effectiveBurst, whitelist: draftWhitelist }),
                      })
                    : t.servers.security.noDraftChanges}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {hasExistingLimit && (
                  <button
                    type="button"
                    onClick={handleRemove}
                    disabled={saving}
                    className="inline-flex items-center rounded-xl px-4 py-2 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t.servers.security.removeRateLimit}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !hasChanges}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  {hasExistingLimit ? t.servers.security.saveChanges : t.servers.security.applyRateLimit}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
