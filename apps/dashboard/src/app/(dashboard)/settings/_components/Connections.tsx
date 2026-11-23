"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useMemo, useState } from "react";
import { CredentialForm } from "@/components/credentials/CredentialForm";
import { AppLogo } from "@/components/AppLogo";
import { Button } from "@/components/ui/button";

import { credentialsApi, type Credential } from "@/lib/api";
import { gitSourcesChangedEvent } from "@/lib/api/git";
import { gitProviderDefinition } from "@repo/core";
import {
  GitConnectionManageButton,
  GitConnectionPrompt,
  GitConnectionStatusRow,
} from "@/components/git/GitConnectionStatusRow";
import { getApiErrorMessage } from "@/lib/api/client";
import { useResourceScope, useScopedResource } from "@/hooks/use-scoped-resource";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";

/**
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

async function loadConnections() {
  const [providers, credentials] = await Promise.all([
    credentialsApi.providers(),
    credentialsApi.list(),
  ]);
  return { providers: providers.data, rows: credentials.data };
}

type ConnectionsProps = { gitProvider?: string };

export function Connections({ gitProvider }: ConnectionsProps) {
  const workspace = useResourceScope();
  const { t } = useI18n();
  const content = <ProviderConnections key={workspace} gitProvider={gitProvider} />;
  return gitProvider ? (
    content
  ) : (
    <SettingsSection
      icon="key"
      title={t.settings.credentials.title}
      description={t.settings.credentials.description}
    >
      {content}
    </SettingsSection>
  );
}

function ProviderConnections({ gitProvider }: ConnectionsProps) {
  const { t, locale } = useI18n();
  const copy = t.settings.credentials;
  const { showToast } = useToast();

  const { data, loading, error, refresh } = useScopedResource(loadConnections);
  const providers = useMemo(
    () =>
      data?.providers.filter((provider) =>
        gitProvider
          ? provider.capability === "git" && provider.id === gitProvider
          : provider.capability !== "git",
      ) ?? [],
    [data, gitProvider],
  );
  /** Provider id whose add-form is open. */
  const [adding, setAdding] = useState<string | null>(null);
  /** Credential id being edited. */
  const [managedId, setManagedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Provider sections arrive after navigation's hash scroll has already run.
  useEffect(() => {
    if (loading) return;
    const provider = providers.find((p) => `#${p.id}` === window.location.hash);
    if (provider) document.getElementById(provider.id)?.scrollIntoView({ block: "start" });
  }, [loading, providers]);

  const byProvider = useMemo(() => {
    const map = new Map<string, Credential[]>();
    for (const row of data?.rows ?? []) {
      const list = map.get(row.provider) ?? [];
      list.push(row);
      map.set(row.provider, list);
    }
    return map;
  }, [data]);

  const refreshConnection = (provider: string) => {
    if (gitProviderDefinition(provider))
      window.dispatchEvent(new Event(gitSourcesChangedEvent(provider)));
    refresh();
  };
  const remove = async (row: Credential) => {
    // Confirmed because it is silent and remote in effect: nothing fails at the moment of
    // deletion — the next deploy that needed this registry does.
    if (!window.confirm(copy.confirmDelete.replace("{name}", row.name))) return;
    setBusy(row.id);
    try {
      await credentialsApi.remove(row.id);
      showToast(copy.toast.deleted, "success");
      refreshConnection(row.provider);
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
      refreshConnection(row.provider);
    } catch (err) {
      showToast(getApiErrorMessage(err, copy.toast.verifyFailed), "error");
    } finally {
      setBusy(null);
    }
  };

  return loading ? (
    <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
      <UiIcon name="spinner" className="size-4 animate-spin" /> {t.settings.common.loading}
    </div>
  ) : error ? (
    <div className="flex items-center justify-between gap-3">
      <p role="alert" className="text-sm text-muted-foreground">
        {error}
      </p>
      <Button type="button" variant="secondary" size="sm" onClick={refresh}>
        {t.onboarding.loading.retry}
      </Button>
    </div>
  ) : providers.length === 0 ? (
    <p className="py-2 text-sm text-muted-foreground">{copy.noProviders}</p>
  ) : (
    <div className="divide-y divide-border/40">
      {providers.map((provider) => {
        const held = byProvider.get(provider.id) ?? [];
        const pLoc = (copy as any)?.providers?.[provider.id];
        const pLabel = pLoc?.label ?? provider.label;
        const pSummary = pLoc?.summary ?? provider.summary;
        const git = gitProvider ? gitProviderDefinition(provider.id) : undefined;
        const toggleAdd = () => {
          setAdding(adding === provider.id ? null : provider.id);
          setEditing(null);
          setManagedId(null);
        };
        const addButton = (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-label={git ? copy.connect : `${copy.add}: ${pLabel}`}
            aria-expanded={adding === provider.id}
            onClick={toggleAdd}
          >
            <UiIcon name="plus" className="size-3.5" />
            {git ? copy.connect : copy.add}
          </Button>
        );
        const content = (
          <div className={git ? "space-y-4" : undefined}>
            {git && held.length === 0 && (
              <GitConnectionPrompt
                provider={git}
                expanded={adding === provider.id}
                onConnect={toggleAdd}
              />
            )}
            {!git && (
              <div className="flex items-start gap-3">
                <AppLogo slug={provider.icon} icon="key" className="mt-1 size-6 shrink-0" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-medium text-foreground">{pLabel}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{pSummary}</p>
                </div>
                {addButton}
              </div>
            )}

            {adding === provider.id && (
              <div className={git ? "rounded-xl bg-muted/30 p-4" : "mt-4 rounded-xl bg-card p-4"}>
                <CredentialForm
                  provider={provider}
                  onCancel={() => setAdding(null)}
                  onSaved={() => {
                    setAdding(null);
                    refreshConnection(provider.id);
                  }}
                />
              </div>
            )}

            {held.length > 0 && (
              <div
                className={
                  git
                    ? "divide-y divide-border/40"
                    : "mt-4 divide-y divide-border/40 rounded-xl bg-card px-4"
                }
              >
                {held.map((row) => {
                  const managing = !git || managedId === row.id;
                  const authorization = row.publicFields.authorization;
                  const tokenField = provider.fields.find((field) => field.type === "secret");
                  const method =
                    authorization === "host-cli"
                      ? ({ icon: "terminal", label: "CLI" } as const)
                      : authorization === "oauth"
                        ? ({ icon: "link", label: "OAuth" } as const)
                        : ({
                            icon: "key",
                            label:
                              tokenField &&
                              (pLoc?.fields?.[tokenField.key]?.label ?? tokenField.label),
                          } as const);
                  const badge =
                    row.status === "invalid" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                        <UiIcon name="warning" className="size-3" /> {copy.badgeInvalid}
                      </span>
                    ) : (
                      <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${row.lastVerifiedAt ? "bg-success-bg text-success" : "bg-muted text-muted-foreground"}`}>
                        {row.lastVerifiedAt && <UiIcon name="check-circle" className="size-3" />}{" "}
                        {row.lastVerifiedAt ? copy.badgeActive : copy.badgeSaved}
                      </span>
                    );
                  const verifiedAt = managing ? row.lastVerifiedAt : null;
                  const verificationError = row.status === "invalid" ? row.lastError : null;
                  const verificationDetails = (verifiedAt || verificationError) && (
                    <div className={git ? "w-full" : "mt-1"}>
                      {verifiedAt && (
                        <p className="text-xs text-muted-foreground">
                          {interpolate(copy.lastVerified, {
                            date: new Date(verifiedAt).toLocaleString(locale, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }),
                          })}
                        </p>
                      )}
                      {verificationError && <p className="text-xs text-warning">{verificationError}</p>}
                    </div>
                  );
                  return (
                    <div key={row.id} className={git ? "py-3 first:pt-0 last:pb-0" : "py-3"}>
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-0 flex-1 basis-40">
                          {git ? (
                            <GitConnectionStatusRow
                              icon={method.icon}
                              brand={git.id}
                              label={row.name}
                              sublabel={[
                                row.publicFields.username && `@${row.publicFields.username}`,
                                method.label,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                              connected={false}
                              status={badge}
                            />
                          ) : (
                            <>
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="truncate text-sm font-medium text-foreground">
                                  {row.name}
                                </p>
                                {badge}
                              </div>
                              <p className="truncate text-xs text-muted-foreground">
                                {row.selector ? (
                                  <span className="font-mono">{row.selector}</span>
                                ) : null}
                                {row.selector && Object.keys(row.publicFields).length > 0
                                  ? " · "
                                  : null}
                                {Object.entries(row.publicFields)
                                  .map(([k, v]) => `${k}: ${v}`)
                                  .join(" · ")}
                              </p>
                            </>
                          )}
                          {!git && verificationDetails}
                        </div>
                        {git && (
                          <GitConnectionManageButton
                            compact
                            label={`${t.actions.completion.manageConnection} · ${row.name}`}
                            expanded={managing}
                            onClick={() => {
                              setManagedId(managing ? null : row.id);
                              setEditing(null);
                              setAdding(null);
                            }}
                          />
                        )}
                        {git && verificationDetails}
                        {managing && (
                          <div className={git ? "flex w-full flex-wrap items-center gap-2 pt-1" : "flex shrink-0 items-center gap-1"}>
                            <button
                              onClick={() => void verify(row)}
                              disabled={busy === row.id}
                              title={copy.verify}
                              className="inline-flex items-center gap-1.5 rounded-lg p-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                            >
                              <UiIcon name={busy === row.id ? "spinner" : "refresh"}
                                className={busy === row.id ? "size-4 animate-spin" : "size-4"} />
                              {git && copy.verify}
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
                              className="ms-auto rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                            >
                              <UiIcon name="trash" className="size-4" />
                            </button>
                          </div>
                        )}
                      </div>

                      {editing === row.id && (
                        <div className="mt-3">
                          <CredentialForm
                            provider={provider}
                            existing={row}
                            onCancel={() => setEditing(null)}
                            onSaved={() => {
                              setEditing(null);
                              refreshConnection(provider.id);
                            }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
        return (
          <section
            key={provider.id}
            id={provider.id}
            aria-label={pLabel}
            className="scroll-mt-24 py-5 first:pt-0 last:pb-0"
          >
            {git ? (
              <SettingsSection
                icon="plug"
                title={copy.title}
                action={held.length > 0 && addButton}
              >
                {content}
              </SettingsSection>
            ) : content}
          </section>
        );
      })}
    </div>
  );
}
