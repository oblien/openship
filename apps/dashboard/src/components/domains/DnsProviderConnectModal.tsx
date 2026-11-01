"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CredentialProvider } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { CredentialForm } from "@/components/credentials/CredentialForm";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { credentialsApi, type Credential } from "@/lib/api/credentials";
import { dnsApi, type DnsProviderDescriptor } from "@/lib/api/dns";
import { ApiError, getApiErrorMessage } from "@/lib/api/client";
import { authClient } from "@/lib/auth-client";

/** Connect or rotate a DNS credential without navigating away from a domain
 * or deployment draft. The same schema, verified write and secret handling as
 * Settings apply here. Saving a credential never writes DNS records. */
export function DnsProviderConnectModal({
  hostname,
  reconnect = false,
  onClose,
  onConnected,
}: {
  hostname?: string;
  reconnect?: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useI18n();
  const copy = t.autoDns.connection;
  const titleId = useId();
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const close = () => {
    if (!busy.current) onClose();
  };
  const { dialog, onKeyDown } = useDialogFocus(close);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [denied, setErrorDenied] = useState(false);
  const [revision, setRevision] = useState(0);
  const [providers, setProviders] = useState<CredentialProvider[]>([]);
  const [descriptors, setDescriptors] = useState<DnsProviderDescriptor[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [providerId, setProviderId] = useState("");
  const [credentialId, setCredentialId] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setErrorDenied(false);
    void (async () => {
      try {
        const role = await authClient.organization.getActiveMemberRole();
        if (role.error) throw new Error(role.error.message || copy.loadFailed);
        if (!["owner", "admin"].includes(role.data?.role ?? "")) {
          if (!cancelled) setErrorDenied(true);
          return;
        }
        const [catalog, dns, held] = await Promise.all([
          credentialsApi.providers(),
          dnsApi.listProviders(),
          credentialsApi.list(),
        ]);
        if (cancelled) return;
        const available = catalog.data.filter(
          (provider) =>
            provider.capability === "dns" && dns.data.some((entry) => entry.name === provider.id),
        );
        setProviders(available);
        setDescriptors(dns.data);
        setCredentials(held.data);
        setProviderId(available[0]?.id ?? "");
        const sameProvider = held.data.filter((entry) => entry.provider === available[0]?.id);
        const invalid = sameProvider.filter((entry) => entry.status === "invalid");
        // Never silently replace an unrelated account's working token.
        setCredentialId(
          reconnect
            ? invalid.length === 1
              ? invalid[0].id
              : sameProvider.length === 1
                ? sameProvider[0].id
                : ""
            : "",
        );
      } catch (err) {
        if (!cancelled) {
          if (err instanceof ApiError && err.status === 403) setErrorDenied(true);
          else setError(getApiErrorMessage(err, copy.loadFailed));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision, reconnect, copy.loadFailed]);

  const provider = providers.find((entry) => entry.id === providerId);
  const descriptor = descriptors.find((entry) => entry.name === providerId);
  const held = credentials.filter((entry) => entry.provider === providerId);
  const existing = held.find((entry) => entry.id === credentialId);

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="space-y-5 p-5 outline-none"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-lg font-semibold text-foreground">
            {reconnect ? t.autoDns.reconnect : t.autoDns.connect}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0"
          disabled={saving}
          aria-label={t.settings.common.close}
          onClick={close}
        >
          <Icon name="close" className="size-4" />
        </Button>
      </div>

      {loading ? (
        <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Icon name="spinner" className="size-4 animate-spin" />
          {t.settings.common.loading}
        </div>
      ) : denied ? (
        <p role="alert" className="rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground">
          {copy.adminRequired}
        </p>
      ) : error ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-danger break-words">
            {error}
          </p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setRevision((value) => value + 1)}
          >
            {t.autoDns.retry}
          </Button>
        </div>
      ) : !provider ? (
        <p className="text-sm text-muted-foreground">{t.settings.credentials.noProviders}</p>
      ) : (
        <>
          <div className="space-y-3 rounded-xl bg-card p-4">
            {providers.length > 1 ? (
              <CustomSelect
                aria-label={copy.provider}
                variant="filled"
                disabled={saving}
                triggerClassName="bg-muted/60 hover:bg-muted"
                value={providerId}
                options={providers.map((entry) => ({ value: entry.id, label: entry.label }))}
                onChange={(value) => {
                  setProviderId(value);
                  setCredentialId("");
                }}
              />
            ) : (
              <p className="text-sm font-medium text-foreground">{provider.label}</p>
            )}
            {descriptor?.tokenUrl && (
              <a
                href={descriptor.tokenUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-primary hover:underline focus-visible:outline-primary"
              >
                {copy.createToken}
                <Icon name="arrow-up-right" className="size-3.5" />
              </a>
            )}
          </div>
          {held.length > 0 && (
            <CustomSelect
              aria-label={copy.connection}
              variant="filled"
              disabled={saving}
              triggerClassName="bg-muted/60 hover:bg-muted"
              value={credentialId}
              options={[
                { value: "", label: copy.newConnection },
                ...held.map((entry) => ({ value: entry.id, label: entry.name })),
              ]}
              onChange={setCredentialId}
            />
          )}
          <CredentialForm
            key={`${providerId}:${credentialId}`}
            provider={provider}
            existing={existing}
            initialName={hostname ? `${provider.label} · ${hostname}` : provider.label}
            onCancel={close}
            onSaved={onConnected}
            onBusyChange={(value) => {
              busy.current = value;
              setSaving(value);
            }}
          />
        </>
      )}
    </div>
  );
}
