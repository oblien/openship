"use client";

import { useCallback, useState, type FormEvent } from "react";
import type { SendingDomainStatus } from "@repo/contracts/managed-mail";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useScopedMutation, useScopedResource } from "@/hooks/use-scoped-resource";
import { managedMailApi } from "@/lib/api/managed-mail";

export function useSenderDomains(enabled: boolean) {
  return useScopedResource(useCallback(async () =>
    enabled ? (await managedMailApi.domains()).data.filter(domain => !domain.disabled) : [], [enabled]));
}

export function useSenderDomain(id?: string) {
  const resource = useScopedResource(useCallback(async () => id ? managedMailApi.sender(id) : null, [id]));
  const [checked, setChecked] = useState<{ source: SendingDomainStatus; result: SendingDomainStatus }>();
  const update = (result: SendingDomainStatus) => {
    if (resource.data?.id === result.id) setChecked({ source: resource.data, result });
  };
  return { ...resource, data: checked && checked.source === resource.data ? checked.result : resource.data, update };
}

export function SenderDomainForm({ initialDomain = "", disabled, onConnected }: {
  initialDomain?: string;
  disabled?: boolean;
  onConnected(domain: SendingDomainStatus): void;
}) {
  const { t } = useI18n();
  const [domain, setDomain] = useState(initialDomain);
  const { busy, error, execute } = useScopedMutation();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const name = domain.trim();
    if (disabled || !name) return;
    const result = await execute(() => managedMailApi.domain(name));
    if (result) onConnected(result);
  }

  return (
    <form onSubmit={submit} className="mt-4 w-full">
      <div className="flex flex-wrap gap-2">
        <Input name="domain" aria-label={t.emails.cloudClient.senderDomain} variant="filled"
          className="min-w-0 flex-[1_1_12rem]" placeholder="example.com" dir="ltr"
          autoCapitalize="none" spellCheck={false} required disabled={busy || disabled}
          value={domain} onChange={event => setDomain(event.target.value)} />
        <Button type="submit" disabled={busy || disabled || !domain.trim()}>
          <Icon name="plus" />{t.emails.cloudClient.connectSender}
        </Button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </form>
  );
}
