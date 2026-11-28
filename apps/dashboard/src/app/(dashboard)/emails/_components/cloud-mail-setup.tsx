import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@repo/ui/icons";
import type { ManagedMailSummary, MailPlacement } from "@repo/contracts/managed-mail";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { MailAdminPanel } from "./admin/admin-panel";
import { MailWelcomeCard } from "./cloud-mail-access";

export function CloudMailSetup({ data, busy, availabilityCheck, onActivate, onRetry, onDomainConnected, sendingHref, provisioning }: {
  data: ManagedMailSummary;
  busy: boolean;
  availabilityCheck: "idle" | "checking" | "checked";
  onActivate(placement: MailPlacement): void;
  onRetry(): void;
  onDomainConnected(nextHref: string): void;
  sendingHref(id?: string): string;
  provisioning?: ReactNode;
}) {
  const { t } = useI18n();
  const copy = t.emails.cloudClient;
  const shared = data.hostingAvailable !== false;
  const reserved = data.reservedHostingAvailable;
  const unavailable = !shared && !reserved;
  const checking = availabilityCheck === "checking";
  const availability = availabilityCheck === "checked" ? copy.sharedStillUnavailable : copy.sharedUnavailable;
  const actions = <>
    {shared && <Button disabled={busy} onClick={() => onActivate("standard")}>
      {busy ? copy.activating : copy.activate}
    </Button>}
    {reserved && <Button variant={shared ? "secondary" : "default"} disabled={busy} onClick={() => onActivate("dedicated")}>
      {shared ? copy.reservedTitle : copy.activate}
    </Button>}
    {unavailable && <Button variant="secondary" disabled={checking} onClick={onRetry}>
      <Icon name="refresh" className={checking ? "motion-safe:animate-spin" : undefined} />
      {checking ? t.emailsAdmin.certificate.checking : copy.checkAvailability}
    </Button>}
  </>;
  const hostingStatus = provisioning ?? (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-card p-5">
      <div className="flex items-start gap-3">
        <Icon name="inbox" className="mt-0.5 size-5 text-muted-foreground" />
        <div>
          <h2 className="font-medium">{reserved && !shared ? copy.reservedTitle : copy.hostingTitle}</h2>
          <p role="status" aria-busy={checking} className="mt-1 text-sm text-muted-foreground">
            {shared ? copy.mailboxSetupHint : reserved ? copy.reservedDescription : availability}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </section>
  );
  return (
    <MailAdminPanel managed limits={data.limits} sendingConfigured={data.sendingConfigured} onRefresh={onRetry}
      setup={{
        hostingStatus,
        mailboxes: <MailWelcomeCard title={copy.inboxOfferTitle} description={copy.includedInboxDescription}>
          {provisioning ? <div className="mt-5 w-full">{provisioning}</div> : <>
            {unavailable && <p role="status" aria-busy={checking} className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-warning" />{availability}
            </p>}
            <div className="mt-6 flex flex-wrap items-center gap-2">
              {actions}
              {unavailable && <Button asChild variant="ghost">
                <Link href={sendingHref()} scroll={false}>{copy.manageSending}<Icon name="arrow-right" className="rtl:rotate-180" /></Link>
              </Button>}
            </div>
          </>}
        </MailWelcomeCard>,
        senderDomains: { configured: !!data.sendingConfigured, sendingHref, onDomainConnected },
      }} />
  );
}
