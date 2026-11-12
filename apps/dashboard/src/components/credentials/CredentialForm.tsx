"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  submitLabel,
  actionsContainer,
}: {
  provider: CredentialProvider;
  existing?: Credential;
  initialName?: string;
  onCancel: () => void;
  onSaved: (credential: Credential) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  /** Contextual label; saving always uses the same provider verification. */
  submitLabel?: string;
  /** Optional external footer; native form ownership keeps submission/validation shared. */
  actionsContainer?: HTMLElement | null;
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
  const [method, setMethod] = useState<"oauth" | "token">(
    provider.authorization?.available && !existing ? "oauth" : "token",
  );
  const authorization = useRef<{ state: string; popup: Window; name: string } | null>(null);
  const mounted = useRef(true);
  const saved = useRef(onSaved);
  saved.current = onSaved;
  const busyChange = useRef(onBusyChange);
  busyChange.current = onBusyChange;
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const finish = async (pending: NonNullable<typeof authorization.current>, message?: string) => {
      authorization.current = null;
      pending.popup.close();
      try {
        if (message) {
          if (active) setError(message);
          return;
        }
        // postMessage contains no trusted credential or token. The same lookup
        // also handles providers that detach the opener through COOP headers.
        const result = await credentialsApi.list();
        if (!active) return;
        const row = result.data.find(
          (row) => row.provider === provider.id && row.name === pending.name,
        );
        if (row) await saved.current(row);
        else setError("The connection window closed. Check Connections or try again.");
      } catch (error) {
        if (active) setError(getApiErrorMessage(error, copy.toast.saveFailed));
      } finally {
        busy.current = false;
        if (active) {
          setSaving(false);
          busyChange.current?.(false);
        }
      }
    };
    const completed = (event: MessageEvent) => {
      const pending = authorization.current;
      if (
        !pending ||
        event.origin !== window.location.origin ||
        event.source !== pending.popup ||
        event.data?.type !== "openship:connection" ||
        event.data?.state !== pending.state
      )
        return;
      void finish(pending, event.data.error ? String(event.data.error) : undefined);
    };
    window.addEventListener("message", completed);
    const timer = window.setInterval(() => {
      const pending = authorization.current;
      if (pending?.state && pending.popup.closed) void finish(pending);
    }, 1000);
    return () => {
      active = false;
      mounted.current = false;
      window.removeEventListener("message", completed);
      window.clearInterval(timer);
      authorization.current?.popup.close();
      authorization.current = null;
      // Saving can replace the form with the next step before its promise settles.
      busy.current = false;
      busyChange.current?.(false);
    };
  }, [provider.id, copy.toast.saveFailed]);

  async function authorize() {
    if (busy.current || !name.trim() || (provider.id !== "railway" && provider.id !== "vercel"))
      return;
    const popup = window.open("about:blank", "_blank", "popup,width=720,height=780");
    if (!popup) {
      setError("Allow a popup to connect this platform.");
      return;
    }
    busy.current = true;
    authorization.current = { state: "", popup, name: name.trim() };
    setSaving(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const grant = await credentialsApi.authorize({ provider: provider.id, name: name.trim() });
      if (!mounted.current || popup.closed) {
        popup.close();
        busy.current = false;
        if (mounted.current) {
          setSaving(false);
          onBusyChange?.(false);
        }
        return;
      }
      authorization.current = { state: grant.state, popup, name: name.trim() };
      popup.location.replace(grant.url);
    } catch (error) {
      popup.close();
      authorization.current = null;
      busy.current = false;
      if (mounted.current) {
        setSaving(false);
        onBusyChange?.(false);
        setError(getApiErrorMessage(error, copy.toast.saveFailed));
      }
    }
  }
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
      const input =
        existing?.publicFields.authorization === "oauth"
          ? { name }
          : { name, selector: provider.selector ? selector : null, values: payload };
      const saved = existing
        ? await credentialsApi.update(existing.id, input)
        : await credentialsApi.create({
            provider: provider.id,
            name,
            selector: provider.selector ? selector : null,
            values: payload,
          });
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

  const cancelButton = (
    <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>
      {t.settings.common.cancel}
    </Button>
  );
  const submitButton = (
    <Button type="submit" form={id} disabled={saving}>
      {saving && <Icon name="spinner" className="size-4 animate-spin" />}
      {method === "oauth"
        ? `Connect ${provider.label}`
        : (submitLabel ?? (existing ? copy.save : copy.connect))}
    </Button>
  );
  const actions = (
    <div
      className={
        actionsContainer === undefined
          ? "flex flex-wrap items-center justify-end gap-2"
          : "grid gap-2"
      }
    >
      {actionsContainer === undefined ? (
        <>
          {cancelButton}
          {submitButton}
        </>
      ) : (
        <>
          {submitButton}
          {cancelButton}
        </>
      )}
    </div>
  );

  return (
    <form
      id={id}
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void (method === "oauth" ? authorize() : submit());
      }}
      aria-busy={saving}
    >
      {!existing && provider.authorization?.available && (
        <div className="flex gap-1 rounded-xl bg-muted/40 p-1">
          {(["oauth", "token"] as const).map((value) => (
            <button
              type="button"
              key={value}
              disabled={saving}
              aria-pressed={method === value}
              className={`rounded-lg px-3 py-2 text-sm ${method === value ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}
              onClick={() => setMethod(value)}
            >
              {value === "oauth" ? `Connect ${provider.label}` : "API token"}
            </button>
          ))}
        </div>
      )}
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

      {existing?.publicFields.authorization === "oauth" && (
        <p className="text-sm text-muted-foreground">
          Connected through {provider.label} authorization. To change accounts or permissions,
          remove this connection and connect again.
        </p>
      )}
      {method === "token" &&
        existing?.publicFields.authorization !== "oauth" &&
        provider.fields.map((field) => {
          const fieldLoc = pLoc?.fields?.[field.key];
          const fieldLabel = fieldLoc?.label ?? field.label;
          const fieldHelp = fieldLoc?.help ?? field.help;
          const inputType = field.inputType ?? (field.type === "secret" ? "password" : "text");
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
                  type={inputType}
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
                  autoComplete={inputType === "password" ? "new-password" : "off"}
                  autoCapitalize={field.type === "secret" ? "none" : undefined}
                  autoCorrect={field.type === "secret" ? "off" : undefined}
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
          );
        })}

      {error && (
        <p role="alert" className="rounded-xl bg-danger-bg p-3 text-sm text-danger break-words">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {method === "oauth"
          ? "Choose the account and projects Openship can access in the provider's authorization window."
          : copy.verifyNote}
      </p>
      {actionsContainer === undefined
        ? actions
        : actionsContainer && createPortal(actions, actionsContainer)}
    </form>
  );
}
