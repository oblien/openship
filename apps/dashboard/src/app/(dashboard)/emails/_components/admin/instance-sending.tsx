"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { emailPlansHref } from "@repo/core/managed-mail";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useCloud } from "@/context/CloudContext";
import { useScopedResource } from "@/hooks/use-scoped-resource";
import { managedMailApi } from "@/lib/api/managed-mail";
import { ManagedSending } from "./managed-sending";
import { Skeleton } from "./_shared/skeleton";
import { SendingTab } from "./sending-tab";
import { mailAdminApi } from "@/lib/api";
import { DisclosureSummary } from "@/components/ui/DisclosureSummary";

type ServerProps = { serverId: string; primaryDomain: string; webmailReady: boolean };

export function InstanceSending(props: ServerProps) {
  const { t } = useI18n();
  const [smtpOpen, setSmtpOpen] = useState(false);
  const relay = useScopedResource(
    useCallback(() => mailAdminApi.relay.get(props.serverId), [props.serverId]),
  );
  return (
    <div className="space-y-4">
      <CloudSending {...props} />
      <details
        className="rounded-2xl bg-card p-5"
        onToggle={(event) => setSmtpOpen(event.currentTarget.open)}
      >
        <DisclosureSummary>{t.emails.cloudClient.smtpSettings}</DisclosureSummary>
        {smtpOpen && (
          <div className="mt-4">
            {relay.error ? (
              <p role="alert">
                {relay.error}{" "}
                <Button size="sm" variant="ghost" onClick={relay.refresh}>
                  {t.actions.retry}
                </Button>
              </p>
            ) : relay.data ? (
              <SendingTab
                serverId={props.serverId}
                primaryDomain={props.primaryDomain}
                relay={relay.data.relay}
                onChanged={relay.refresh}
              />
            ) : (
              <ConnectionSkeleton />
            )}
          </div>
        )}
      </details>
    </div>
  );
}

function CloudSending(props: ServerProps) {
  const { t } = useI18n();
  const cloud = useCloud();
  const copy = t.emails.cloudClient;
  if (cloud.loading) return <ConnectionSkeleton />;
  if (cloud.connected)
    return <LinkedSending {...props} organizationId={cloud.cloudUser?.organizationId} />;
  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-card p-5">
      <div>
        <h2 className="text-base font-medium">{copy.cloudSending}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{copy.linkSendingHint}</p>
      </div>
      <Button variant="secondary" disabled={cloud.connecting} onClick={cloud.startConnect}>
        <Icon name="cloud" />
        {t.settings.cloud.connectButton}
      </Button>
    </section>
  );
}

function ConnectionSkeleton() {
  return (
    <div aria-busy="true" className="space-y-3 rounded-2xl bg-card p-5">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3 w-64 max-w-full" />
    </div>
  );
}

function LinkedSending({
  serverId,
  primaryDomain,
  organizationId,
  webmailReady,
}: ServerProps & { organizationId?: string }) {
  const { t } = useI18n();
  const copy = t.emails.cloudClient;
  const account = useScopedResource(managedMailApi.summary);
  if (account.error || account.data?.billingUnavailable)
    return (
      <div role="alert" className="flex items-center gap-3 rounded-2xl bg-card p-5 text-sm">
        {account.error || copy.billingUnavailable}
        <Button size="sm" variant="secondary" onClick={account.refresh}>
          {t.actions.retry}
        </Button>
      </div>
    );
  if (!account.data) return <ConnectionSkeleton />;
  const allowance = account.data.sendingAllowance ?? account.data.limits?.recipients;
  if (!account.data.plan && !allowance)
    return (
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-card p-5">
        <div>
          <h2 className="text-base font-medium">{copy.cloudSending}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.sendingPlanHint}</p>
        </div>
        <Button asChild>
          <Link href={emailPlansHref(null, organizationId, "sending")}>
            {copy.browsePlans}
            <Icon name="arrow-right" />
          </Link>
        </Button>
      </section>
    );
  return (
    <ManagedSending
      initialDomain={primaryDomain}
      serviceId={serverId}
      webmailReady={webmailReady}
      allowance={allowance}
      configured={account.data.sendingConfigured}
      onConfigured={account.refresh}
    />
  );
}
