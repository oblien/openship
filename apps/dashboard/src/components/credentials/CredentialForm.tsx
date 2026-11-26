"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  normalizeCredentialSelector,
  supportsConnectionOAuth,
  type CredentialProvider,
} from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { credentialsApi, type Credential } from "@/lib/api/credentials";
import { authorizeConnection } from "@/lib/authorize-connection";
import { getApiErrorMessage } from "@/lib/api/client";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DisclosureSummary } from "@/components/ui/DisclosureSummary";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useToast } from "@/context/ToastContext";
import { CreateGitTokenLink } from "@/components/git/CreateGitTokenLink";
import CopyCommand from "@/components/shared/CopyCommand";

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
  const submission = useRef<AbortController | null>(null);
  const gitLabSetup = provider.id === "gitlab" && !existing;
  const [nameInput, setName] = useState(existing?.name ?? initialName);
  const name = gitLabSetup ? nameInput.trim() || provider.label : nameInput;
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
  const linkedMethod = existing?.publicFields.authorization;
  const linked = linkedMethod === "oauth" || linkedMethod === "host-cli";
  const methods: { id: "oauth" | "token" | "host-cli"; label: string }[] = [];
  const oauthLabel = gitLabSetup ? copy.gitlab.continue : `Connect ${provider.label}`;
  if (provider.authorization?.available) methods.push({ id: "oauth", label: oauthLabel });
  if (provider.fields.length) methods.push({
    id: "token",
    label: gitLabSetup ? copy.gitlab.useToken : "API token",
  });
  if (provider.authorization?.hostCli) methods.push({ id: "host-cli", label: copy.gitlab.useCli });
  const [method, setMethod] = useState<"oauth" | "token" | "host-cli">(
    provider.authorization?.available && !existing ? "oauth" : "token",
  );
  const formRef = useRef<HTMLFormElement>(null);
  const previousMethod = useRef(method);
  useEffect(() => {
    if (gitLabSetup && method !== previousMethod.current) {
      // Switching removes the focused alternative from the footer.
      const form = formRef.current;
      const target =
        method === "token"
          ? form?.querySelector<HTMLInputElement>('input[type="password"]')
          : form?.querySelector<HTMLButtonElement>('button[type="submit"]:not([disabled])');
      (target ?? form)?.focus();
    }
    previousMethod.current = method;
  }, [gitLabSetup, method]);
  const busyChange = useRef(onBusyChange);
  busyChange.current = onBusyChange;
  useEffect(
    () => () => {
      submission.current?.abort();
      submission.current = null;
      busyChange.current?.(false);
    },
    [provider.id, existing?.id],
  );

  const selectorChanged = Boolean(
    existing &&
    provider.selector &&
    normalizeCredentialSelector(provider, selector) !== existing.selector,
  );
  const pLoc = (copy as any)?.providers?.[provider.id];
  const selectorLabel = pLoc?.selector?.label ?? provider.selector?.label;
  const selectorHelp = pLoc?.selector?.help ?? provider.selector?.help;

  async function saveCredential(selectedMethod: typeof method, signal: AbortSignal) {
    if (!existing && selectedMethod === "oauth" && supportsConnectionOAuth(provider.id))
      return authorizeConnection(provider.id, name.trim(), signal, t.auth.security.expired);
    if (!existing && selectedMethod === "host-cli" && provider.id === "gitlab")
      return (await credentialsApi.connectCli({ provider: provider.id, name })).data;

    const fields = {
      name,
      selector: provider.selector ? selector : null,
      values: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "")),
    };
    if (existing)
      return (await credentialsApi.update(existing.id, linked ? { name } : fields)).data;
    return (await credentialsApi.create({ ...fields, provider: provider.id })).data;
  }

  async function submit(selectedMethod = method) {
    if (submission.current) return;
    const controller = new AbortController();
    submission.current = controller;
    setSaving(true);
    busyChange.current?.(true);
    setError(null);
    try {
      const credential = await saveCredential(selectedMethod, controller.signal);
      if (controller.signal.aborted) return;
      showToast(existing ? copy.toast.updated : copy.toast.created, "success");
      await onSaved(credential);
    } catch (error) {
      if (!controller.signal.aborted) setError(getApiErrorMessage(error, copy.toast.saveFailed));
    } finally {
      if (submission.current === controller) {
        submission.current = null;
        setSaving(false);
        busyChange.current?.(false);
      }
    }
  }

  const cancelButton = (
    <Button
      type="button"
      variant="ghost"
      disabled={saving && method !== "oauth"}
      onClick={onCancel}
    >
      {t.settings.common.cancel}
    </Button>
  );
  if (!existing && methods.length === 0) {
    return <div className="space-y-3"><p role="status" className="text-sm text-muted-foreground">
      {provider.label} authorization is unavailable on this installation.
    </p>{cancelButton}</div>;
  }
  const nameField = (
    <Input
      id={`${id}-name`}
      variant="filled"
      value={nameInput}
      required={!gitLabSetup}
      disabled={saving}
      onChange={(event) => setName(event.target.value)}
      placeholder={gitLabSetup ? provider.label : copy.namePlaceholder}
      aria-label={gitLabSetup ? copy.gitlab.connectionName : undefined}
    />
  );
  const submitButton = (
    <Button
      type="submit"
      form={id}
      disabled={saving || (gitLabSetup && method === "token" && !values.apiToken?.trim())}
    >
      {saving && <Icon name="spinner" className="size-4 animate-spin" />}
      {!saving && gitLabSetup && method === "oauth" && <Icon name="gitlab" aria-hidden="true" />}
      {method === "oauth"
        ? oauthLabel
        : (submitLabel ??
          (existing ? copy.save : gitLabSetup ? t.library.connect.token.connect : copy.connect))}
    </Button>
  );
  const actions = (
    <div
      className={
        actionsContainer === undefined
          ? "ms-auto flex flex-wrap items-center justify-end gap-2"
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
  const renderedActions =
    actionsContainer === undefined
      ? actions
      : actionsContainer && createPortal(actions, actionsContainer);

  return (
    <form
      ref={formRef}
      id={id}
      tabIndex={gitLabSetup ? -1 : undefined}
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      aria-busy={saving}
    >
      {!existing && !gitLabSetup && methods.length > 1 && (
        <div className="flex gap-1 rounded-xl bg-muted/40 p-1">
          {methods.map(({ id: value, label }) => (
            <button
              type="button"
              key={value}
              disabled={saving}
              aria-pressed={method === value}
              className={`rounded-lg px-3 py-2 text-sm ${method === value ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}
              onClick={() => setMethod(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {!gitLabSetup && (
        <div>
          <label
            htmlFor={`${id}-name`}
            className="mb-1.5 block text-sm font-medium text-foreground"
          >
            {copy.fieldName}
          </label>
          {nameField}
        </div>
      )}

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

      {linked && (
        <p className="text-sm text-muted-foreground">
          Connected through {linkedMethod === "host-cli" ? "glab CLI" : provider.label}. To change
          accounts or permissions, remove this connection and connect again.
        </p>
      )}
      {method === "token" &&
        !linked &&
        provider.fields.map((field) => {
          const fieldLoc = pLoc?.fields?.[field.key];
          const fieldLabel = fieldLoc?.label ?? field.label;
          const gitLabToken = provider.id === "gitlab" && field.key === "apiToken";
          const fieldHelp = fieldLoc?.help ?? field.help;
          const inputType = field.inputType ?? (field.type === "secret" ? "password" : "text");
          return (
            <div key={field.key}>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <label
                  htmlFor={`${id}-${field.key}`}
                  className="text-sm font-medium text-foreground"
                >
                  {fieldLabel}
                </label>
                {gitLabToken && (
                  <CreateGitTokenLink provider="gitlab" label={copy.gitlab.createToken} />
                )}
              </div>
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
                  aria-describedby={fieldHelp ? `${id}-${field.key}-help` : undefined}
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

      {gitLabSetup ? (
        <>
          {method === "oauth" && (
            <p className="text-sm text-muted-foreground">{copy.gitlab.oauthHelp}</p>
          )}
          {method === "host-cli" && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{copy.gitlab.cliHelp}</p>
              <CopyCommand command="glab auth login --hostname gitlab.com" />
            </div>
          )}
          <details className="text-sm text-muted-foreground open:space-y-2">
            <DisclosureSummary>{copy.gitlab.connectionName}</DisclosureSummary>
            {nameField}
          </details>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {method === "oauth"
            ? "Choose the account and projects OpenShip can access in the provider's authorization window."
            : copy.verifyNote}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-danger-bg p-3 text-sm text-danger break-words">
          {error}
        </p>
      )}
      {gitLabSetup ? (
        <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/40 pt-4">
          {methods.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              {methods
                .filter((option) => option.id !== method)
                .map((option) => (
                  <Button
                    key={option.id}
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      setError(null);
                      setMethod(option.id);
                      if (option.id === "oauth") void submit(option.id);
                    }}
                  >
                    <Icon
                      name={
                        option.id === "oauth"
                          ? "gitlab"
                          : option.id === "token"
                            ? "key"
                            : "terminal"
                      }
                      aria-hidden="true"
                    />
                    {option.label}
                  </Button>
                ))}
            </div>
          )}
          {renderedActions}
        </footer>
      ) : (
        renderedActions
      )}
    </form>
  );
}
