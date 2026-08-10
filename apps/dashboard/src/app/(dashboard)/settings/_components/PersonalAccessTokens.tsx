"use client";

import React, { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, Trash2, Copy, Check, Loader2, ShieldCheck, Lock, SlidersHorizontal } from "lucide-react";
import { SettingsSection } from "./SettingsSection";
import {
  tokensApi,
  getApiErrorMessage,
  type AccessToken,
  type PickerGrant,
  type ResourceType,
} from "@/lib/api";
import { GrantPickerModal } from "./GrantPickerModal";
import { useModal } from "@/context/ModalContext";
import { useToast } from "@/context/ToastContext";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

const EXPIRY_OPTIONS = [
  { days: 0 },
  { days: 30 },
  { days: 90 },
  { days: 365 },
] as const;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function PersonalAccessTokens() {
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  const expiryOptionLabel = (days: number) =>
    days === 30
      ? t.settings.tokens.expiry.days30
      : days === 90
        ? t.settings.tokens.expiry.days90
        : days === 365
          ? t.settings.tokens.expiry.year1
          : t.settings.tokens.expiry.none;
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [expiryDays, setExpiryDays] = useState(0);
  // Resource scope: when enabled the token is limited to `scopeGrants`.
  const [scopeEnabled, setScopeEnabled] = useState(false);
  const [scopeGrants, setScopeGrants] = useState<PickerGrant[]>([]);
  // The one-time plaintext token, shown until dismissed.
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { selfHosted } = usePlatform();
  const availableTypes: ResourceType[] = selfHosted
    ? ["project", "server", "mail_server", "backup_destination", "audit", "github_installation", "github_repository"]
    : ["project", "backup_destination", "billing", "audit", "github_installation", "github_repository"];

  // Open the shared grant picker (blurred, centered) to set the token's scope.
  const openScopePicker = () => {
    let id = "";
    id = showModal({
      // Same wide shell as the member-grants editor — one row per resource with
      // its permission chips inline (see ResourcePicker).
      maxWidth: "min(94vw, 900px)",
      showCloseButton: false,
      customContent: (
        <GrantPickerModal
          title={t.settings.tokens.scopePicker.title}
          subtitle={t.settings.tokens.scopePicker.subtitle}
          initial={scopeGrants}
          availableTypes={availableTypes}
          saveLabel={t.settings.tokens.scopePicker.saveLabel}
          onSave={(g) => setScopeGrants(g)}
          onClose={() => hideModal(id)}
        />
      ),
    });
  };

  const refresh = useCallback(async () => {
    try {
      const res = await tokensApi.list();
      setTokens(res?.data ?? []);
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.tokens.toast.loadFailed), "error", t.settings.common.toast.accessTokens);
    } finally {
      setLoading(false);
    }
  }, [showToast, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    if (!name.trim()) {
      showToast(t.settings.tokens.toast.giveName, "error", t.settings.common.toast.accessTokens);
      return;
    }
    if (scopeEnabled && scopeGrants.length === 0) {
      showToast(t.settings.tokens.toast.pickResource, "error", t.settings.common.toast.accessTokens);
      return;
    }
    setCreating(true);
    try {
      // Scope intent is stated, not inferred: the guard above already rejects
      // "scoped but nothing picked", so reaching here with no grants means the
      // user left scoping off and really does want a full-access token.
      const wantScoped = scopeEnabled && scopeGrants.length > 0;
      const res = await tokensApi.create({
        name: name.trim(),
        readOnly,
        ...(expiryDays > 0 ? { expiresInDays: expiryDays } : {}),
        ...(wantScoped ? { grants: scopeGrants } : { fullAccess: true }),
      });
      setNewToken(res.data.token);
      setShowForm(false);
      setName("");
      setReadOnly(false);
      setExpiryDays(0);
      setScopeEnabled(false);
      setScopeGrants([]);
      await refresh();
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.tokens.toast.createFailed), "error", t.settings.common.toast.accessTokens);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string, tokenName: string) => {
    try {
      await tokensApi.revoke(id);
      showToast(interpolate(t.settings.tokens.toast.revoked, { name: tokenName }), "success", t.settings.common.toast.accessTokens);
      await refresh();
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.tokens.toast.revokeFailed), "error", t.settings.common.toast.accessTokens);
    }
  };

  const copyToken = async () => {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  };

  const active = tokens.filter((t) => !t.revokedAt);

  return (
    <SettingsSection
      icon={KeyRound}
      title={t.settings.tokens.title}
      description={t.settings.tokens.description}
    >
      {/* What a token can actually do — set expectations honestly */}
      <div className="mb-4 flex gap-2.5 rounded-xl border border-border/50 bg-muted/30 p-3">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="text-xs leading-relaxed text-muted-foreground">
          {t.settings.tokens.explainer1} <span className="font-medium text-foreground">{t.settings.tokens.explainerActsAsYou}</span> {t.settings.tokens.explainer2}{" "}
          <span className="font-medium text-foreground">{t.settings.tokens.explainerReadOnly}</span> {t.settings.tokens.explainer3}{" "}
          <span className="font-medium text-foreground">{t.settings.tokens.explainerLimit}</span> {t.settings.tokens.explainer4}
        </div>
      </div>

      {/* One-time reveal after create */}
      {newToken && (
        <div className="mb-4 rounded-xl border border-primary/30 bg-primary/[0.04] p-4">
          <p className="text-sm font-medium text-foreground mb-1">{t.settings.tokens.copyNow}</p>
          <p className="text-xs text-muted-foreground mb-3">
            {t.settings.tokens.onlyTime}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">
              {newToken}
            </code>
            <button
              onClick={copyToken}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? t.settings.common.copied : t.settings.common.copy}
            </button>
          </div>
          <button
            onClick={() => setNewToken(null)}
            className="mt-3 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {t.settings.common.done}
          </button>
        </div>
      )}

      {/* Create form */}
      {showForm ? (
        <div className="mb-4 rounded-xl border border-border/50 p-4 space-y-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.settings.tokens.namePlaceholder}
            className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
                className="size-4 rounded border-border/60"
              />
              {t.settings.tokens.readOnly}
            </label>
            <select
              value={expiryDays}
              onChange={(e) => setExpiryDays(Number(e.target.value))}
              className="px-3 py-1.5 bg-muted/30 border border-border/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.days} value={o.days}>{expiryOptionLabel(o.days)}</option>
              ))}
            </select>
          </div>

          {/* Resource scope */}
          <div className="rounded-lg border border-border/50 bg-muted/[0.04] p-3">
            <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={scopeEnabled}
                onChange={(e) => setScopeEnabled(e.target.checked)}
                className="size-4 rounded border-border/60"
              />
              <Lock className="size-3.5 text-muted-foreground" />
              {t.settings.tokens.limitToResources}
            </label>
            {scopeEnabled && (
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={openScopePicker}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-transparent px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/40 transition-colors"
                >
                  <SlidersHorizontal className="size-3.5" />
                  {t.settings.tokens.chooseResources}
                </button>
                <span className="text-xs text-muted-foreground">
                  {scopeGrants.length > 0
                    ? interpolate(
                        scopeGrants.length === 1
                          ? t.settings.tokens.resourcesSelectedOne
                          : t.settings.tokens.resourcesSelectedMany,
                        { count: String(scopeGrants.length) },
                      )
                    : t.settings.tokens.noResourcesSelected}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCreate}
              disabled={creating}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              {t.settings.tokens.createToken}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {t.settings.common.cancel}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="mb-4 inline-flex items-center gap-2 px-4 py-2 bg-muted/50 text-foreground text-sm font-medium rounded-lg hover:bg-muted transition-colors"
        >
          <Plus className="size-4" />
          {t.settings.tokens.newToken}
        </button>
      )}

      {/* Token list */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
          <Loader2 className="size-4 animate-spin" /> {t.settings.tokens.loading}
        </div>
      ) : active.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">{t.settings.tokens.noActive}</p>
      ) : (
        <div className="divide-y divide-border/50">
          {active.map((tok) => (
            <div key={tok.id} className="flex items-center gap-3 py-3">
              <KeyRound className="size-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground truncate">{tok.name}</p>
                  {tok.readOnly && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <ShieldCheck className="size-3" /> {t.settings.tokens.badgeReadOnly}
                    </span>
                  )}
                  {tok.scoped && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      <Lock className="size-3" /> {t.settings.tokens.badgeScoped}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground font-mono">
                  {tok.tokenPrefix}…
                  <span className="font-sans">{interpolate(t.settings.tokens.metaLine, { lastUsed: fmtDate(tok.lastUsedAt), expires: fmtDate(tok.expiresAt) })}</span>
                </p>
              </div>
              <button
                onClick={() => void handleRevoke(tok.id, tok.name)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-danger hover:border-danger-border transition-colors"
              >
                <Trash2 className="size-3.5" />
                {t.settings.tokens.revoke}
              </button>
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
