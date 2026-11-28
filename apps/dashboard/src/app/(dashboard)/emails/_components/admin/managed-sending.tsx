"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useResourceScope, useScopedMutation, useScopedResource } from "@/hooks/use-scoped-resource";
import { managedMailApi } from "@/lib/api/managed-mail";
import { SendingQuotaCard, useSendingUsage } from "./sending-usage";
import { SendingLimitRow, SendingLimitSkeleton, useSendingLimits } from "./sending-limits";
import { MailApiKeys, MailApiQuickstart } from "./mail-api-keys";
import { SenderDomainVerification } from "./sender-domain-verification";
import { SenderDomainDetailSkeleton } from "./sender-domain-skeleton";
import { Skeleton } from "./_shared/skeleton";
import { SenderDomainForm, useSenderDomain, useSenderDomains } from "./sender-domain-form";
import { SendTestMailModal } from "./SendTestMailModal";

interface SendingProps {
  initialDomain?: string;
  serviceId?: string;
  webmailReady?: boolean;
  canAddDomain?: boolean;
  configured?: boolean;
  allowance?: number;
  onConfigured?(): void;
}

export function ManagedSending(props: SendingProps) {
  const scope = useResourceScope();
  const params = useSearchParams();
  const senderId = params.get("senderId") || undefined;
  const list = params.get("senderView") === "list" && !senderId;
  return <SendingWorkspace key={JSON.stringify([scope, props.serviceId, senderId, list])}
    {...props} senderId={senderId} list={list} />;
}

function SendingWorkspace({ initialDomain, senderId, list, serviceId, webmailReady, canAddDomain = true, configured, allowance, onConfigured }: SendingProps & { senderId?: string; list: boolean }) {
  const path = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const { t } = useI18n();
  const c = t.emails.cloudClient;
  const [testOpen, setTestOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const enabled = !!configured || requested || !!senderId || list;
  const domains = useSenderDomains(enabled);
  const singleDomain = domains.data?.length === 1 ? domains.data[0] : undefined;
  const selectedId = senderId ?? (list ? undefined : singleDomain?.id);
  const sender = useSenderDomain(selectedId);
  const status = sender.data;
  const keys = useScopedResource(useCallback(() => enabled ? managedMailApi.keys() : Promise.resolve(null), [enabled]));
  const mailboxDomain = status?.state === "ready" && webmailReady ? status.domain : undefined;
  const installed = useScopedResource(useCallback(() => serviceId && mailboxDomain
    ? managedMailApi.webmailKey(serviceId, mailboxDomain) : Promise.resolve(null), [serviceId, mailboxDomain]));
  const hostedId = canAddDomain && webmailReady === undefined && status?.state === "ready" ? status.id : undefined;
  const hosted = useScopedResource(useCallback(() => serviceId && hostedId
    ? managedMailApi.hostedSending(serviceId, hostedId) : Promise.resolve(null), [serviceId, hostedId]));
  const installedKey = installed.data?.sending;
  const activeKey = hosted.data?.configured || (!!installedKey?.apiOrigin && keys.data?.data.some(key => key.id === installedKey.keyId && key.domainId === selectedId));
  const nativeDomainId = webmailReady !== undefined && status?.state === "ready" ? status.id : undefined;
  const relay = useScopedResource(useCallback(() => serviceId && nativeDomainId
    ? managedMailApi.apiRelay(serviceId, nativeDomainId) : Promise.resolve(null), [serviceId, nativeDomainId]));
  const apiRelayEnabled = !!relay.data?.keyId && keys.data?.data.some(key => key.id === relay.data?.keyId && key.domainId === nativeDomainId);
  const usage = useSendingUsage(enabled);
  const caps = useSendingLimits("domains", enabled, usage.data?.policy.period ?? allowance);
  const { busy, error, execute } = useScopedMutation();

  function refresh() {
    if (!enabled) setRequested(true);
    else {
      domains.refresh(); keys.refresh(); usage.refresh(); caps.refresh();
      if (selectedId) sender.refresh();
      if (hostedId) hosted.refresh();
    }
  }
  function senderHref(id?: string) {
    const next = new URLSearchParams(params.toString());
    if (id) {
      next.delete("senderView");
      next.set("senderId", id);
    } else {
      next.delete("senderId");
      next.set("senderView", "list");
    }
    return path + "?" + next.toString();
  }
  const readError = domains.error || keys.error || usage.error || caps.error || hosted.error;
  return (
    <div className="@container/sending space-y-4">
      <div className="grid grid-cols-1 items-start gap-4 @min-[60rem]/sending:grid-cols-[minmax(0,1.5fr)_minmax(260px,1fr)]">
        <div className="min-w-0 space-y-4">
          <section className="min-w-0 rounded-2xl bg-card p-5 sm:p-6">
            {selectedId ? <>
              <Link href={senderHref()} scroll={false} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                <Icon name="arrow-left" className="size-4 rtl:rotate-180" />{c.senderDomains}
              </Link>
              {sender.error && <p role="alert" className="mt-4 text-sm text-danger">{sender.error} <Button size="sm" variant="ghost" onClick={sender.refresh}>{t.actions.retry}</Button></p>}
              {sender.loading && <div className="mt-4"><SenderDomainDetailSkeleton /></div>}
              {status && <SenderDomainVerification key={status.id} sender={status} disabled={busy}
                limit={<SendingLimitRow kind="domains" identity={status.domain} limits={caps.limits} />}
                onVerified={result => { sender.update(result); domains.refresh(); }}>
                {canAddDomain && <Button size="sm" disabled={busy || status.state === "disabled" || status.state === "verification_failed"} onClick={() => setTestOpen(true)}>
                  <Icon name="send" />{t.emailsAdmin.test.sendButton}
                </Button>}
                {canAddDomain && status.state === "ready" && serviceId && (webmailReady === false ? (
                  <Button size="sm" variant="secondary" asChild><Link href={`/deploy/mail?serverId=${encodeURIComponent(serviceId)}`}>{t.emailsAdmin.overview.deployWebmail}</Link></Button>
                ) : (
                  <Button size="sm" variant="secondary" disabled={busy || activeKey || (webmailReady ? installed.loading || keys.loading : hosted.loading)} onClick={() => void execute(async () => {
                    await managedMailApi.connect(serviceId, status.id);
                    if (webmailReady) installed.refresh();
                    else hosted.refresh();
                    keys.refresh();
                  })}>
                    {activeKey ? c.connected : webmailReady ? c.enableWebmail : c.enableSending}
                  </Button>
                ))}
                {nativeDomainId && serviceId && <div className="w-full space-y-2">
                  <Button size="sm" variant="secondary" disabled={busy || relay.loading || !!relay.error || keys.loading} onClick={() => void execute(async () => {
                    if (apiRelayEnabled) await managedMailApi.disableApiRelay(serviceId, nativeDomainId);
                    else await managedMailApi.enableApiRelay(serviceId, nativeDomainId);
                    relay.refresh(); keys.refresh();
                  })}>{apiRelayEnabled ? c.disableApiRelay : c.enableApiRelay}</Button>
                  <p className="text-xs text-muted-foreground">{c.apiRelayHint}</p>
                  {relay.error && <p role="alert" className="text-sm text-danger">{relay.error} <Button size="sm" variant="ghost" onClick={relay.refresh}>{t.actions.retry}</Button></p>}
                </div>}
              </SenderDomainVerification>}
            </> : enabled && !list && domains.loading ? (
              <div className="space-y-4">
                <div className="flex h-5 items-center"><Skeleton className="h-3 w-24" /></div>
                <SenderDomainDetailSkeleton />
              </div>
            ) : <>
              <div className="flex items-center gap-2.5"><Icon name="globe" className="size-5 text-muted-foreground" /><h2 className="text-lg font-medium">{c.senderDomains}</h2></div>
              {canAddDomain && <>
                <p className="mt-2 text-sm text-muted-foreground">{c.verifySender}</p>
                <SenderDomainForm initialDomain={initialDomain} disabled={busy} onConnected={result => {
                  if (!configured) onConfigured?.();
                  router.push(senderHref(result.id), { scroll: false });
                }} />
              </>}
              {enabled && domains.loading && <div role="status" aria-label={t.emailsAdmin.dns.loading}
                className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 py-2">
                <Skeleton className="h-3 w-40 max-w-full" />
                <SendingLimitSkeleton />
                <Skeleton className="h-3 w-12" />
              </div>}
              {!!domains.data?.length && (
                <ul className="mt-5 divide-y divide-border/60 border-t border-border/60">
                  {domains.data.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Button asChild variant="link" className="min-w-0 justify-start px-0">
                      <Link href={senderHref(item.id)} scroll={false}><bdi className="truncate">{item.domain}</bdi><Icon name="chevron-right" className="rtl:rotate-180" /></Link>
                    </Button>
                    <SendingLimitRow kind="domains" identity={item.domain} limits={caps.limits} />
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
                      if (window.confirm(interpolate(c.releaseConfirm, { domain: item.domain }))) void execute(async () => {
                        await managedMailApi.release(item.id);
                        refresh();
                      });
                    }}>{c.release}</Button>
                  </li>)}
                </ul>
              )}
              {enabled && domains.data?.length === 0 && !canAddDomain && <p className="mt-4 text-sm text-muted-foreground">{c.noSenders}</p>}
            </>}
          </section>
          <MailApiKeys key={selectedId ?? "list"} domain={status} domainId={selectedId} canCreate={canAddDomain}
            keys={keys.data} loading={enabled && keys.loading} onChanged={keys.refresh}
            refreshAction={(configured !== false || enabled) && (
              <Button variant="ghost" size={enabled ? "icon" : "sm"} title={enabled ? t.actions.refresh : c.viewUsage}
                disabled={busy || (enabled && (keys.loading || keys.refreshing || domains.loading || usage.loading))} onClick={refresh}>
                <Icon name="refresh" /><span className={enabled ? "sr-only" : undefined}>{enabled ? t.actions.refresh : c.viewUsage}</span>
              </Button>
            )} />
        </div>
        <div className="min-w-0 space-y-4">
          <SendingQuotaCard usage={usage.data} allowance={allowance} inactive={!enabled && configured === false}
            loading={enabled && usage.loading} onRetry={usage.error ? usage.refresh : undefined} />
          <MailApiQuickstart domain={status?.state === "ready" ? status.domain : undefined} />
        </div>
      </div>
      {caps.editor}
      {status && testOpen && (
        <SendTestMailModal key={status.id} open onClose={() => setTestOpen(false)} managedDomain={status} onStatus={sender.update}
          onSubmitted={() => { usage.refresh(); caps.refresh(); }} />
      )}
      {(error || readError) && <p role="alert" className="rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger">{error || readError}</p>}
      {installed.error && <p role="alert" className="text-sm text-danger">{installed.error} <Button size="sm" variant="ghost" onClick={installed.refresh}>{t.actions.retry}</Button></p>}
    </div>
  );
}
