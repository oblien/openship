"use client";

import { useId, useRef, useState } from "react";
import { normalizeCredentialSelector, type CredentialProvider } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { credentialsApi, type Credential } from "@/lib/api/credentials";
import { getApiErrorMessage } from "@/lib/api/client";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useToast } from "@/context/ToastContext";

/** One schema-driven form for Settings and in-context connections. Stored
 * secrets never reach an input; a blank secret on edit means keep it, but only
 * while the credential's destination is unchanged. */
export function CredentialForm({
  provider,
  existing,
  initialName = "",
  onCancel,
  onSaved,
  onBusyChange,
}: {
  provider: CredentialProvider;
  existing?: Credential;
  initialName?: string;
  onCancel: () => void;
  onSaved: (credential: Credential) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const copy = t.settings.credentials;
  const { showToast } = useToast();
  const id = useId();
  const busy = useRef(false);
  const [name, setName] = useState(existing?.name ?? initialName);
  const [selector, setSelector] = useState(existing?.selector ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const field of provider.fields) {
      if (field.type !== "secret") seed[field.key] = existing?.publicFields[field.key] ?? "";
    }
    return seed;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectorChanged = Boolean(
    existing &&
    provider.selector &&
    normalizeCredentialSelector(provider, selector) !== existing.selector,
  );
  const pLoc = (copy as any)?.providers?.[provider.id];
  const selectorLabel = pLoc?.selector?.label ?? provider.selector?.label;
  const selectorHelp = pLoc?.selector?.help ?? provider.selector?.help;

  async function submit() {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const payload: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        if (value !== "") payload[key] = value;
      }
      const input = { name, selector: provider.selector ? selector : null, values: payload };
      const saved = existing
        ? await credentialsApi.update(existing.id, input)
        : await credentialsApi.create({ provider: provider.id, ...input });
      showToast(existing ? copy.toast.updated : copy.toast.created, "success");
      await onSaved(saved.data);
    } catch (err) {
      // Provider failures are redacted by the API. Keep the actionable reason
      // next to the form instead of losing it behind the enclosing dialog.
      setError(getApiErrorMessage(err, copy.toast.saveFailed));
    } finally {
      busy.current = false;
      setSaving(false);
      onBusyChange?.(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      aria-busy={saving}
    >
      <div>
        <label htmlFor={`${id}-name`} className="mb-1.5 block text-sm font-medium text-foreground">
          {copy.fieldName}
        </label>
        <Input
          id={`${id}-name`}
          variant="filled"
          value={name}
          required
          disabled={saving}
          onChange={(event) => setName(event.target.value)}
          placeholder={copy.namePlaceholder}
        />
      </div>

      {provider.selector && (
        <div>
          <label
            htmlFor={`${id}-selector`}
            className="mb-1.5 block text-sm font-medium text-foreground"
          >
            {selectorLabel}
          </label>
          <Input
            id={`${id}-selector`}
            variant="filled"
            value={selector}
            disabled={saving}
            required={provider.selector.required}
            onChange={(event) => setSelector(event.target.value)}
            placeholder={provider.selector.placeholder ?? ""}
            className="font-mono"
            aria-describedby={provider.selector.help ? `${id}-selector-help` : undefined}
          />
          {provider.selector.help && (
            <p id={`${id}-selector-help`} className="mt-1.5 text-xs text-muted-foreground">
              {selectorHelp}
            </p>
          )}
        </div>
      )}

      {provider.fields.map((field) => {
        const fieldLoc = pLoc?.fields?.[field.key];
        const fieldLabel = fieldLoc?.label ?? field.label;
        const fieldHelp = fieldLoc?.help ?? field.help;
        return (
        <div key={field.key}>
          <label
            htmlFor={`${id}-${field.key}`}
            className="mb-1.5 block text-sm font-medium text-foreground"
          >
            {fieldLabel}
          </label>
          {field.type === "select" ? (
            <CustomSelect
              id={`${id}-${field.key}`}
              variant="filled"
              disabled={saving}
              triggerClassName="bg-muted/60 hover:bg-muted"
              value={values[field.key] ?? ""}
              options={[...(field.options ?? [])]}
              onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
              placeholder={copy.selectPlaceholder}
            />
          ) : (
            <Input
              id={`${id}-${field.key}`}
              variant="filled"
              disabled={saving}
              type={field.type === "secret" ? "password" : "text"}
              value={values[field.key] ?? ""}
              required={
                field.required && !(existing && field.type === "secret" && !selectorChanged)
              }
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.key]: event.target.value }))
              }
              placeholder={
                field.type === "secret" && existing && !selectorChanged
                  ? copy.secretKeptPlaceholder
                  : (field.placeholder ?? "")
              }
              autoComplete={field.type === "secret" ? "new-password" : "off"}
              spellCheck={field.type === "secret" ? false : undefined}
              aria-describedby={field.help ? `${id}-${field.key}-help` : undefined}
              className={field.type === "secret" ? "font-mono" : undefined}
            />
          )}
          {fieldHelp && (
            <p id={`${id}-${field.key}-help`} className="mt-1.5 text-xs text-muted-foreground">
              {fieldHelp}
            </p>
          )}
        </div>
      );})}

      {error && (
        <p role="alert" className="rounded-xl bg-danger-bg p-3 text-sm text-danger break-words">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{copy.verifyNote}</p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>
          {t.settings.common.cancel}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Icon name="spinner" className="size-4 animate-spin" />}
          {existing ? copy.save : copy.connect}
        </Button>
      </div>
    </form>
  );
}
