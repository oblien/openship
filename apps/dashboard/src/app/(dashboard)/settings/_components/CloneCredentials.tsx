"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useId, useState } from "react";
import { settingsApi, githubApi, type CloneCredentialsState } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { usePlatform } from "@/context/PlatformContext";
import { SettingsSection } from "./SettingsSection";
import { useI18n } from "@/components/i18n-provider";
import { CreateGitHubTokenLink } from "@/components/github/CreateGitHubTokenLink";
import { Toggle } from "@/components/project-settings/ServerSideSwitch";
import { Button } from "@/components/ui/button";

/**
 * GitHub clone credentials - user-global PAT for cloning private repos.
 *
 * This is the second tier in the clone resolver chain (after per-project
 * tokens) and the recommended escape hatch when the user doesn't want to
 * install the GitHub App. Stored encrypted server-side; the server never
 * echoes the token back so the UI only sees `{ hasToken, setAt, asDefault }`.
 */
export function CloneCredentials() {
  const { showToast } = useToast();
  const { t } = useI18n();
  const copy = t.settings.cloneCredentials;
  const tokenInputId = useId();
  const { deployMode } = usePlatform();
  // Whether identity forwarding applies is the BACKEND's call (it mirrors
  // relayConfigEligible). `deployMode` is only the pre-load fallback so a slow
  // /github/status doesn't flash a toggle that then disappears.
  const [forwardingAvailable, setForwardingAvailable] = useState(deployMode === "desktop");
  const [state, setState] = useState<CloneCredentialsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [tokenInput, setTokenInput] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingDefault, setTogglingDefault] = useState(false);
  const [forwardGit, setForwardGit] = useState(false);
  const [togglingForward, setTogglingForward] = useState(false);
  const tokenBusy = saving || togglingDefault;

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await settingsApi.get();
      setState(res.cloneToken);
      setForwardGit(res.forwardGitToServer);
      // Same source of truth the GitHub card uses, so the two can't disagree.
      void githubApi
        .getStatusDeduped<any>()
        .then((gh) => {
          const m = gh?.capabilities?.methods?.find((x: any) => x.kind === "forwarding");
          if (m) setForwardingAvailable(Boolean(m.available));
        })
        .catch(() => {});
    } catch {
      // Silent - section just shows empty.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    const trimmed = tokenInput.trim();
    if (!trimmed) {
      showToast(t.settings.cloneCredentials.toast.pasteFirst, "error", t.settings.common.toast.cloneCredentials);
      return;
    }
    // Light validation - accept classic ghp_, fine-grained github_pat_, or
    // long opaque tokens (gh CLI / device-flow). We don't reject anything;
    // just warn if the prefix looks off so paste typos don't silently fail.
    const looksLikeGitHubToken =
      /^ghp_/.test(trimmed) || /^github_pat_/.test(trimmed) || trimmed.length >= 40;
    if (!looksLikeGitHubToken) {
      showToast(
        t.settings.cloneCredentials.toast.notLikeToken,
        "error",
        t.settings.common.toast.cloneCredentials,
      );
    }
    setSaving(true);
    try {
      const next = await settingsApi.updateCloneCredentials({
        token: trimmed,
        // Default to using-as-default if user is setting one explicitly.
        // They can toggle off afterward.
        asDefault: state?.asDefault ?? true,
      });
      setState(next.cloneToken);
      setTokenInput("");
      setShowToken(false);
      setEditing(false);
      showToast(t.settings.cloneCredentials.toast.saved, "success", t.settings.common.toast.cloneCredentials);
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.cloneCredentials.toast.saveFailed), "error", t.settings.common.toast.cloneCredentials);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      const next = await settingsApi.updateCloneCredentials({ token: null });
      setState(next.cloneToken);
      setTokenInput("");
      setShowToken(false);
      setEditing(false);
      showToast(t.settings.cloneCredentials.toast.cleared, "success", t.settings.common.toast.cloneCredentials);
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.cloneCredentials.toast.clearFailed), "error", t.settings.common.toast.cloneCredentials);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleDefault = async (next: boolean) => {
    setTogglingDefault(true);
    try {
      const updated = await settingsApi.updateCloneCredentials({ asDefault: next });
      setState(updated.cloneToken);
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.cloneCredentials.toast.updateDefaultFailed), "error", t.settings.common.toast.cloneCredentials);
    } finally {
      setTogglingDefault(false);
    }
  };

  const handleToggleForward = async (next: boolean) => {
    setForwardGit(next); // optimistic
    setTogglingForward(true);
    try {
      const res = await settingsApi.updateForwardGitToServer(next);
      setForwardGit(res.forwardGitToServer);
    } catch (err) {
      setForwardGit(!next); // revert
      showToast(getApiErrorMessage(err, t.settings.cloneCredentials.forwardGitFailed), "error", t.settings.common.toast.cloneCredentials);
    } finally {
      setTogglingForward(false);
    }
  };

  return (
    <SettingsSection
      icon="key"
      title={copy.title}
      description={copy.description}
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <UiIcon name="spinner" className="size-4 animate-spin" />
          {copy.loading}
        </div>
      ) : (
        <div className="space-y-5">
          {!state?.hasToken || editing ? (
            <form
              className="space-y-3"
              aria-busy={tokenBusy}
              onSubmit={(event) => {
                event.preventDefault();
                if (!tokenBusy) void handleSave();
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={tokenInputId} className="text-sm font-medium text-foreground">
                  {copy.tokenLabel}
                </label>
                <CreateGitHubTokenLink label={t.settings.github.tokenCreate} />
              </div>
              <div className="relative">
                <input
                  id={tokenInputId}
                  type={showToken ? "text" : "password"}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder={copy.placeholder}
                  disabled={tokenBusy}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="none"
                  dir="ltr"
                  className="h-10 w-full rounded-xl border border-border/50 bg-muted/20 ps-3 pe-10 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 size-7 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  aria-label={showToken ? copy.hideToken : copy.showToken}
                >
                  {showToken ? <UiIcon name="eye-off" className="size-3.5" /> : <UiIcon name="eye" className="size-3.5" />}
                </button>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {editing && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setEditing(false);
                      setTokenInput("");
                      setShowToken(false);
                    }}
                    disabled={tokenBusy}
                  >
                    {t.settings.common.cancel}
                  </Button>
                )}
                <Button type="submit" size="sm" disabled={tokenBusy || !tokenInput.trim()}>
                  {saving && <UiIcon name="spinner" className="size-3.5 animate-spin" />}
                  {copy.saveToken}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/30 p-3.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{copy.tokenSaved}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {copy.lastUpdated}{" "}
                  {state.setAt ? new Date(state.setAt).toLocaleString() : copy.justNow}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setEditing(true)}
                  disabled={tokenBusy}
                >
                  {copy.replace}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClear}
                  disabled={tokenBusy}
                  className="text-danger hover:bg-danger-bg hover:text-danger"
                >
                  <UiIcon name={saving ? "spinner" : "trash"} className={`size-3.5 ${saving ? "animate-spin" : ""}`} />
                  {copy.clear}
                </Button>
              </div>
            </div>
          )}

          {((state?.hasToken && !editing) || forwardingAvailable) && (
            <div className="divide-y divide-border/50">
              {state?.hasToken && !editing && (
                <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{copy.useAsDefault}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{copy.useAsDefaultDesc}</p>
                  </div>
                  <Toggle
                    checked={state.asDefault}
                    onChange={handleToggleDefault}
                    disabled={tokenBusy}
                    aria-label={copy.useAsDefault}
                  />
                </div>
              )}
              {/* Desktop relay only: the backend owns forwarding availability. */}
              {forwardingAvailable && (
                <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{copy.forwardGitLabel}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{copy.forwardGitDesc}</p>
                  </div>
                  <Toggle
                    checked={forwardGit}
                    onChange={handleToggleForward}
                    disabled={togglingForward}
                    aria-label={copy.forwardGitLabel}
                  />
                </div>
              )}
            </div>
          )}

          <details className="group text-xs text-muted-foreground">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
              <UiIcon name="info" className="size-3.5 shrink-0" />
              {copy.helpTitle}
              <UiIcon name="chevron-down" className="size-3 shrink-0 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-3 space-y-2 leading-relaxed">
              <p>
                {copy.scopeHintPrefix} <span className="font-mono">repo</span> {copy.scopeHintSuffix}
              </p>
              <p>{copy.intro}</p>
            </div>
          </details>
        </div>
      )}
    </SettingsSection>
  );
}
