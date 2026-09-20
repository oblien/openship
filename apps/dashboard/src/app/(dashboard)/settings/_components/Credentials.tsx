"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { normalizeCredentialSelector, type CredentialProvider } from "@repo/core";

import { credentialsApi, type Credential } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";

/**
 * Every third-party credential Openship holds, in one place.
 *
 * SCHEMA-DRIVEN, deliberately: the form for each provider is rendered from the field list
 * the server sends (`CREDENTIAL_PROVIDERS` in @repo/core), so adding a provider needs no
 * change here. Hardcoding a form per provider is how the client ends up asking for a field
 * the server does not store — the exact drift this screen exists to end, having replaced
 * three separate credential UIs.
 *
 * SECRETS: an input for a secret is `type="password"`, never receives a stored value, and
 * carries no reveal toggle. The list shows the server's constant mask. Leaving a secret
 * blank on edit means "keep the stored one" — the field is then OMITTED from the payload,
 * because sending `""` is a different request (it would store an empty secret).
 */

/** Same devicon base `STACK_ICONS` uses, so a provider logo needs no new asset pipeline. */
const DEVICON = "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons";

function ProviderLogo({ slug, className }: { slug: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  // Falls back to a key glyph rather than a broken image: devicon does not carry every
  // brand, and a provider without a logo must still be usable.
  if (failed || !slug) return <KeyRound className={className} />;
  return (
    <img
      src={`${DEVICON}/${slug}/${slug}-original.svg`}
      alt=""
      aria-hidden
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

export function Credentials() {
  const { t } = useI18n();
  const copy = t.settings.credentials;
  const { showToast } = useToast();

  const [providers, setProviders] = useState<CredentialProvider[]>([]);
  const [rows, setRows] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  /** Provider id whose add-form is open. */
  const [adding, setAdding] = useState<string | null>(null);
  /** Credential id being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, c] = await Promise.all([credentialsApi.providers(), credentialsApi.list()]);
      setProviders(p.data ?? []);
      setRows(c.data ?? []);
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.toast.loadFailed), "error");
    } finally {
      setLoading(false);
    }
  }, [copy.toast.loadFailed, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const byProvider = useMemo(() => {
    const map = new Map<string, Credential[]>();
    for (const row of rows) {
      const list = map.get(row.provider) ?? [];
      list.push(row);
      map.set(row.provider, list);
    }
    return map;
  }, [rows]);

  const remove = async (row: Credential) => {
    // Confirmed because it is silent and remote in effect: nothing fails at the moment of
    // deletion — the next deploy that needed this registry does.
    if (!window.confirm(copy.confirmDelete.replace("{name}", row.name))) return;
    setBusy(row.id);
    try {
      await credentialsApi.remove(row.id);
      showToast(copy.toast.deleted, "success");
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.toast.deleteFailed), "error");
    } finally {
      setBusy(null);
    }
  };

  const verify = async (row: Credential) => {
    setBusy(row.id);
    try {
      const res = await credentialsApi.verify(row.id);
      showToast(
        res.data.status === "active" ? copy.toast.verifyOk : copy.toast.verifyFailed,
        res.data.status === "active" ? "success" : "error",
      );
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.toast.verifyFailed), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection icon={KeyRound} title={copy.title} description={copy.description}>
      {loading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t.settings.common.loading}
        </div>
      ) : providers.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{copy.noProviders}</p>
      ) : (
        <div className="space-y-6">
          {providers.map((provider) => {
            const held = byProvider.get(provider.id) ?? [];
            return (
              <div key={provider.id} className="rounded-xl border border-border/50 p-4">
                <div className="mb-3 flex items-start gap-3">
                  <ProviderLogo slug={provider.icon} className="mt-0.5 size-5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{provider.label}</p>
                    <p className="text-xs text-muted-foreground">{provider.summary}</p>
                  </div>
                  <button
                    onClick={() => {
                      setAdding(adding === provider.id ? null : provider.id);
                      setEditing(null);
                    }}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    <Plus className="size-3.5" />
                    {copy.add}
                  </button>
                </div>

                {adding === provider.id && (
                  <CredentialForm
                    provider={provider}
                    onCancel={() => setAdding(null)}
                    onSaved={async () => {
                      setAdding(null);
                      await load();
                    }}
                  />
                )}

                {held.length === 0 ? (
                  <p className="py-1 text-xs text-muted-foreground">{copy.noneForProvider}</p>
                ) : (
                  <div className="divide-y divide-border/50">
                    {held.map((row) => (
                      <div key={row.id} className="py-3">
                        <div className="flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
                              {row.status === "invalid" ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                                  <AlertTriangle className="size-3" /> {copy.badgeInvalid}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                  <CheckCircle2 className="size-3" /> {copy.badgeActive}
                                </span>
                              )}
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {row.selector ? <span className="font-mono">{row.selector}</span> : null}
                              {row.selector && Object.keys(row.publicFields).length > 0 ? " · " : null}
                              {Object.entries(row.publicFields).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                            </p>
                            {row.status === "invalid" && row.lastError && (
                              <p className="mt-1 text-xs text-warning">{row.lastError}</p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              onClick={() => void verify(row)}
                              disabled={busy === row.id}
                              title={copy.verify}
                              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                            >
                              {busy === row.id ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <RefreshCw className="size-4" />
                              )}
                            </button>
                            <button
                              onClick={() => {
                                setEditing(editing === row.id ? null : row.id);
                                setAdding(null);
                              }}
                              className="rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              {copy.edit}
                            </button>
                            <button
                              onClick={() => void remove(row)}
                              disabled={busy === row.id}
                              title={copy.delete}
                              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                            >
                              <Trash2 className="size-4" />
                            </button>
                          </div>
                        </div>

                        {editing === row.id && (
                          <div className="mt-3">
                            <CredentialForm
                              provider={provider}
                              existing={row}
                              onCancel={() => setEditing(null)}
                              onSaved={async () => {
                                setEditing(null);
                                await load();
                              }}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * The add/edit form for ONE provider, rendered from its declared fields.
 *
 * On edit a secret input starts EMPTY. A blank secret keeps the stored value only while
 * the selector is unchanged; moving a credential to another destination requires the
 * operator to enter the secret again. The stored value is never sent to the browser.
 */
function CredentialForm({
  provider,
  existing,
  onCancel,
  onSaved,
}: {
  provider: CredentialProvider;
  existing?: Credential;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const copy = t.settings.credentials;
  const { showToast } = useToast();

  const [name, setName] = useState(existing?.name ?? "");
  const [selector, setSelector] = useState(existing?.selector ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const field of provider.fields) {
      // Readable fields are seeded from what is stored; secrets never are.
      if (field.type !== "secret") seed[field.key] = existing?.publicFields[field.key] ?? "";
    }
    return seed;
  });
  const [saving, setSaving] = useState(false);
  const selectorChanged = Boolean(
    existing &&
    provider.selector &&
    normalizeCredentialSelector(provider, selector) !== existing.selector,
  );

  const submit = async () => {
    setSaving(true);
    try {
      // Drop blanks. For a secret on edit the server keeps the stored value only when the
      // selector is unchanged; readable blanks mean "unchanged" in either case.
      const payload: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) if (v !== "") payload[k] = v;

      if (existing) {
        await credentialsApi.update(existing.id, {
          name,
          selector: provider.selector ? selector : null,
          values: payload,
        });
        showToast(copy.toast.updated, "success");
      } else {
        await credentialsApi.create({
          provider: provider.id,
          name,
          selector: provider.selector ? selector : null,
          values: payload,
        });
        showToast(copy.toast.created, "success");
      }
      await onSaved();
    } catch (err) {
      // Carries the provider's own redacted reason ("ghcr.io rejected these credentials"),
      // which is the actionable part — the server verifies before it stores.
      showToast(getApiErrorMessage(err, copy.toast.saveFailed), "error");
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20";

  return (
    <div className="mb-4 space-y-3 rounded-xl border border-border/50 bg-muted/20 p-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">{copy.fieldName}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={copy.namePlaceholder}
          className={inputClass}
        />
      </div>

      {provider.selector && (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {provider.selector.label}
          </label>
          <input
            type="text"
            value={selector}
            onChange={(e) => setSelector(e.target.value)}
            placeholder={provider.selector.placeholder ?? ""}
            className={`${inputClass} font-mono`}
          />
          {provider.selector.help && (
            <p className="mt-1 text-xs text-muted-foreground">{provider.selector.help}</p>
          )}
        </div>
      )}

      {provider.fields.map((field) => (
        <div key={field.key}>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{field.label}</label>
          {field.type === "select" ? (
            <select
              value={values[field.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              className={inputClass}
            >
              <option value="">{copy.selectPlaceholder}</option>
              {field.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={field.type === "secret" ? "password" : "text"}
              value={values[field.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              // The stored secret never reaches the browser. While the destination is
              // unchanged, the placeholder says it is set; changing the destination removes
              // that promise because the secret must be entered again.
              placeholder={
                field.type === "secret" && existing && !selectorChanged
                  ? copy.secretKeptPlaceholder
                  : (field.placeholder ?? "")
              }
              autoComplete={field.type === "secret" ? "new-password" : "off"}
              className={`${inputClass}${field.type === "secret" ? " font-mono" : ""}`}
            />
          )}
          {field.help && <p className="mt-1 text-xs text-muted-foreground">{field.help}</p>}
        </div>
      ))}

      <div className="flex items-center gap-2">
        <button
          onClick={() => void submit()}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {existing ? copy.save : copy.connect}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {t.settings.common.cancel}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{copy.verifyNote}</p>
    </div>
  );
}
