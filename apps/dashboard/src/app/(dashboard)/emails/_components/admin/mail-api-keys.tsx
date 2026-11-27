"use client";

import { useState, type ReactNode } from "react";
import { MAIL_SEND_PATH, type SendingDomainStatus } from "@repo/contracts/managed-mail";
import { Icon } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useScopedMutation } from "@/hooks/use-scoped-resource";
import { managedMailApi } from "@/lib/api/managed-mail";
import { usePlatform } from "@/context/PlatformContext";
import { DisclosureSummary } from "@/components/ui/DisclosureSummary";
import { DataTable, RowActionsMenu } from "./_shared/data-table";
import { getCloudApiOrigin, getMarketingOrigin } from "@/lib/api/urls";
import { copyText } from "@/lib/clipboard";
import { useHostedModal } from "./_shared/hosted-modal";

type IssuedKey = Awaited<ReturnType<typeof managedMailApi.issueKey>>;
type KeyList = Awaited<ReturnType<typeof managedMailApi.keys>>;

export function MailApiKeys({ domain, domainId, keys, loading, canCreate, onChanged, refreshAction }: {
  domain?: SendingDomainStatus | null;
  domainId?: string;
  keys: KeyList | null;
  loading: boolean;
  canCreate: boolean;
  onChanged(): void;
  refreshAction: ReactNode;
}) {
  const { t, locale } = useI18n();
  const c = t.emails.cloudClient;
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const { busy, error, execute } = useScopedMutation();
  const visibleKeys = domainId ? keys?.data.filter(key => key.domainId === domainId) : keys?.data;

  const dates = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  function date(value?: string | null) {
    return value ? <time dateTime={value}>{dates.format(new Date(value))}</time> : "—";
  }

  async function create() {
    if (!canCreate || domain?.state !== "ready") return;
    const result = await execute(() => managedMailApi.issueKey(domain.id));
    if (result) {
      setIssued(result);
      onChanged();
    }
  }

  return (
    <section aria-label={c.sendingKeys} className="min-w-0 rounded-2xl bg-card p-4 sm:p-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-medium text-foreground">{c.sendingKeys}</h2>
          {!!visibleKeys?.length && <span className="rounded-md bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground">{visibleKeys.length}</span>}
        </div>
        <div className="flex items-center gap-1">
          {refreshAction}
          {canCreate && domain?.state === "ready" && (
            <Button size="sm" variant="secondary" disabled={busy || !!issued} onClick={create}>
              <Icon name="plus" />{c.createKey}
            </Button>
          )}
        </div>
      </header>
      {loading || visibleKeys?.length ? (
        <DataTable rows={visibleKeys ?? []} loading={loading && !keys} skeletonRows={1} rowKey={key => key.id}
          columns={[
            { key: "key", header: c.apiKey, width: "1fr", cell: key => (
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Icon name="key" className="size-4" /></span>
                <div className="min-w-0">
                  <code dir="ltr" className="block truncate text-start text-xs font-medium text-foreground" title={key.prefix + "…"}>{key.prefix}…</code>
                  <span className="block truncate text-xs text-muted-foreground" title={key.name}>{key.smtp ? c.smtpRelay : key.legacy ? c.legacyApiKey : domainId ? c.sendOnly : key.name}</span>
                  <span className="mt-1 block text-xs text-muted-foreground @min-[32rem]/table:hidden">{c.lastUsed} · {key.lastUsedAt === null ? c.neverUsed : date(key.lastUsedAt)}</span>
                </div>
              </div>
            ) },
            { key: "created", header: t.support.created, width: "130px", hideBelow: "table-sm", cell: key => date(key.createdAt) },
            { key: "lastUsed", header: c.lastUsed, width: "130px", hideBelow: "table-sm", cell: key =>
              key.lastUsedAt === null ? <span className="text-muted-foreground">{c.neverUsed}</span> : date(key.lastUsedAt) },
          ]}
          rowActions={key => <RowActionsMenu label={interpolate(t.emailsAdmin.shared.rowActions, { name: key.prefix })}
            actions={[{ id: "revoke", label: t.settings.tokens.revoke, variant: "danger", icon: <Icon name="trash" className="size-4" />, disabled: busy,
              onClick: () => void execute(async () => { await managedMailApi.revoke(key.id); onChanged(); }),
            }]} />} />
      ) : (
        <div className="flex items-center gap-3 rounded-xl bg-card p-4">
          <Icon name="key" className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            {visibleKeys && <p className="text-sm font-medium">{c.noApiKeys}</p>}
            <p className="text-sm text-muted-foreground">{domain?.state === "ready" ? interpolate(c.apiKeyDomainHint, { domain: domain.domain }) : domainId ? c.verifySender : c.apiKeyHint}</p>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {issued && <IssuedKeyDialog credential={issued} onClose={() => setIssued(null)} />}
    </section>
  );
}

export function MailApiQuickstart({ domain }: { domain?: string }) {
  const { t } = useI18n();
  const { cloudAuthUrl, cloudApiUrl } = usePlatform();
  const c = t.emails.cloudClient;
  const endpoint = getCloudApiOrigin(cloudApiUrl) + "/api" + MAIL_SEND_PATH;
  const docs = getMarketingOrigin(cloudAuthUrl) + "/docs/api/mail";
  const payload = JSON.stringify({
    from: "hello@" + (domain ?? "example.com"), to: ["reader@example.org"],
    subject: "Hello", text: "Hello from OpenShip Mail.", idempotencyKey: "hello-001",
  }, null, 2);
  const request = [
    "curl " + endpoint,
    '  -H "Authorization: Bearer $OPENSHIP_MAIL_API_KEY"',
    "  -H 'Content-Type: application/json'",
    "  -d '" + payload + "'",
  ].join(" \\" + "\n");

  return (
    <aside aria-label={c.sendFromApp} className="min-w-0 rounded-2xl bg-card p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-base font-medium text-foreground">
        <Icon name="code" className="size-4 text-muted-foreground" />{c.sendFromApp}
      </h2>
      <div className="mt-4 rounded-xl bg-background px-3">
        <div className="flex min-w-0 items-center gap-2.5 py-2">
          <code dir="ltr" className="flex min-w-0 flex-1 items-center gap-2 text-xs">
            <span className="rounded-md bg-info/10 px-1.5 py-1 text-[11px] font-semibold text-info">POST</span>
            <span className="truncate" title={endpoint}>/api{MAIL_SEND_PATH}</span>
          </code>
          <MailCopyButton value={endpoint} label={c.copyEndpoint} />
        </div>
        <details className="border-t border-border/60 pb-1.5 pt-1">
          <DisclosureSummary className="min-h-8 text-xs font-medium text-muted-foreground">{c.curlExample}</DisclosureSummary>
          <div className="flex justify-end"><MailCopyButton value={request} label={t.referrals.copyCode} showLabel /></div>
          <pre dir="ltr" tabIndex={0} className="mb-2 max-h-64 overflow-auto pb-2 text-start font-mono text-xs leading-relaxed">{request}</pre>
        </details>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1">
        {[[c.sdkExample, "sdk-example"], [c.apiReference, "send-email"]].map(([label, anchor]) => (
          <a key={anchor} href={docs + "#" + anchor} target="_blank" rel="noopener noreferrer"
            className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
            {label}<Icon name="arrow-up-right" className="size-3.5" />
          </a>
        ))}
      </div>
    </aside>
  );
}

function IssuedKeyDialog({ credential, onClose }: { credential: IssuedKey; onClose(): void }) {
  const { t } = useI18n();
  const c = t.emails.cloudClient;
  useHostedModal({
    open: true,
    onClose,
    content: () => (
      <section aria-label={c.createdKey} className="space-y-5 p-6">
        <header>
          <h2 className="text-lg font-medium">{c.createdKey}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{c.saveKey}</p>
        </header>
        <CredentialValue label={c.apiKey} value={credential.key} />
        <div className="flex justify-end"><Button onClick={onClose}>{t.settings.common.done}</Button></div>
      </section>
    ),
  });
  return null;
}

function CredentialValue({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);
  const toggle = revealed ? t.emailsAdmin.mailboxes.create.hide : t.emailsAdmin.mailboxes.create.show;
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-1 rounded-xl bg-background px-3 py-1">
        <code dir="ltr" className="min-w-0 flex-1 select-all truncate text-start text-xs">
          {!revealed ? "••••••••••••" : value}
        </code>
        <Button type="button" size="icon" variant="ghost" className="size-8 shrink-0"
          title={toggle} aria-label={toggle + " · " + label} aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>
          <Icon name={revealed ? "eye-off" : "eye"} />
        </Button>
        <MailCopyButton value={value} label={t.settings.common.copy + " · " + label} />
      </div>
    </div>
  );
}

function MailCopyButton({ value, label, showLabel }: { value: string; label: string; showLabel?: boolean }) {
  const { t } = useI18n();
  const [feedback, setFeedback] = useState<"copied" | "error" | null>(null);
  const message = feedback === "copied" ? t.settings.common.copied : feedback === "error" ? t.settings.accountSecurity.copyFailed : "";
  async function copy() {
    try {
      await copyText(value);
      setFeedback("copied");
    } catch {
      // diagnostics-ignore: The control reports clipboard failure and the text is selectable.
      setFeedback("error");
    }
  }
  return (
    <div className="flex shrink-0 flex-col items-end">
      <Button type="button" size={showLabel ? "sm" : "icon"} variant="ghost" className={showLabel ? "h-7" : "size-8"} onClick={copy} aria-label={label} title={message || label}>
        <Icon name={feedback === "copied" ? "check" : "copy"} />{showLabel && (feedback === "copied" ? message : label)}
      </Button>
      <span role="status" className={feedback === "error" ? "max-w-36 text-xs text-danger" : "sr-only"}>{message}</span>
    </div>
  );
}
