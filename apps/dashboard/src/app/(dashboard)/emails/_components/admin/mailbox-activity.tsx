"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { UserAvatar } from "@/components/ui/UserAvatar";
import type { MailServerStats } from "@/lib/api";
import { SendingLimitRow, type SendingLimits } from "./sending-limits";

type Inbox = NonNullable<MailServerStats["inbox"]>;
export type MailActivitySidebar = (domainSwitch: ReactNode) => ReactNode;
const MAILBOXES_PER_PAGE = 12;
const mailboxGrid = "grid min-w-0 gap-3 @min-[28rem]/activity:grid-cols-2";

export function MailboxActivity({
  inbox,
  loading,
  error,
  refresh,
  mailboxHref,
  domainsHref,
  renderSidebar,
  sending,
  setup,
}: {
  inbox?: Inbox;
  loading?: boolean;
  error?: string | null;
  refresh: () => void;
  mailboxHref: (domain: string) => string;
  domainsHref: string;
  renderSidebar: MailActivitySidebar;
  sending?: SendingLimits;
  setup?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const c = t.emails.cloudClient;
  const [domainFilter, setDomainFilter] = useState("");
  const [visible, setVisible] = useState(MAILBOXES_PER_PAGE);
  const domains = inbox?.domains;
  const selected = domains?.find(({ domain }) => domain === domainFilter);
  const mailboxes = useMemo(
    () =>
      (selected ? [selected] : (domains ?? [])).flatMap(({ domain, mailboxes }) =>
        mailboxes.map((mailbox) => ({ ...mailbox, domain })),
      ),
    [domains, selected],
  );
  const messages = selected ? selected.messages : inbox?.total;
  const number = (value?: number | null) => value?.toLocaleString(locale) ?? "—";
  const emptyDomain = selected ?? domains?.[0];
  const emptyHref = emptyDomain ? mailboxHref(emptyDomain.domain) : domainsHref;
  const notice = error || ((!inbox && !loading) || messages === null ? c.inboxUnavailable : null);
  const domainSwitch = domains && domains.length > 1 && (
    <CustomSelect
      aria-label={t.emailsAdmin.mailboxes.domainLabel}
      className="min-w-0 @min-[44rem]/mail-overview:order-first"
      value={selected?.domain ?? ""}
      onChange={(domain) => {
        setDomainFilter(domain);
        setVisible(MAILBOXES_PER_PAGE);
      }}
      variant="default"
      triggerClassName="w-full rounded-2xl border-0 bg-card px-4 py-3 text-start hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
      options={[
        {
          value: "",
          label: t.projects.monitoring.allDomains,
          icon: <Icon name="globe" className="size-3.5 shrink-0" />,
          description: number(inbox?.total) + " " + c.inboxMessages,
        },
        ...domains.map(({ domain, messages, mailboxes }) => ({
          value: domain,
          label: domain,
          icon: <Icon name="globe" className="size-3.5 shrink-0" />,
          description: [
            interpolate(
              mailboxes.length === 1
                ? t.emailsAdmin.domains.deleteForm.mailboxOne
                : t.emailsAdmin.domains.deleteForm.mailboxOther,
              { count: number(mailboxes.length) },
            ),
            number(messages) + " " + c.inboxMessages,
          ].join(" · "),
        })),
      ]}
    />
  );
  return (
    <>
      <section
        aria-label={c.mailboxActivity}
        aria-busy={loading}
        className="@container/activity min-w-0 space-y-3"
      >
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1.5">
            <h2 className="text-base font-medium">{c.mailboxActivity}</h2>
            {inbox && (
              <span aria-live="polite" className="text-xs text-muted-foreground">
                <span className="font-medium tabular-nums text-foreground">{number(messages)}</span>{" "}
                {c.inboxMessages}
              </span>
            )}
          </div>
          {!setup && <Button
            variant="ghost"
            size="icon"
            aria-label={t.actions.refresh}
            disabled={loading}
            onClick={refresh}
          >
            <Icon name="refresh" className={loading ? "animate-spin" : undefined} />
          </Button>}
        </header>
        {!setup && notice && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        {setup ?? (mailboxes.length ? (
          <>
            <ul className={mailboxGrid}>
              {mailboxes.slice(0, visible).map(({ username, messages, domain }) => {
                const address = (
                  <bdi dir="ltr" className="block truncate" title={username}>
                    {username}
                  </bdi>
                );
                return (
                  <li
                    key={username}
                    aria-label={username}
                    className="flex min-w-0 flex-col gap-3 rounded-2xl bg-card p-4"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span aria-hidden="true">
                        <UserAvatar name={username} className="size-9 rounded-xl text-sm" />
                      </span>
                      <h3 className="min-w-0 text-sm font-medium">
                        <Link
                          className="block rounded hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                          scroll={false}
                          href={mailboxHref(domain)}
                        >
                          {address}
                        </Link>
                      </h3>
                    </div>
                    <dl className="flex items-center justify-between gap-2 border-t border-border/50 pt-2.5">
                      <dt className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Icon name="inbox" className="size-3.5 shrink-0" />
                        {c.inboxMessages}
                      </dt>
                      <dd className="text-base font-semibold tabular-nums">{number(messages)}</dd>
                    </dl>
                    {sending && (
                      <SendingLimitRow kind="senders" identity={username} limits={sending} />
                    )}
                  </li>
                );
              })}
            </ul>
            {mailboxes.length > visible && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setVisible((n) => n + MAILBOXES_PER_PAGE)}
              >
                {t.support.loadMore}
              </Button>
            )}
          </>
        ) : loading ? (
          <div className={mailboxGrid} aria-hidden="true">
            {[0, 1].map((key) => (
              <div
                key={key}
                className="space-y-4 rounded-2xl bg-card p-4 motion-safe:animate-pulse"
              >
                <div className="h-9 w-1/2 rounded-lg bg-muted" />
                <div className="border-t border-border/50 pt-4">
                  <div className="h-5 w-3/4 rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          inbox && (
            <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-card p-4">
              <p className="text-sm text-muted-foreground">
                {emptyDomain
                  ? t.emailsAdmin.mailboxes.emptyTitle
                  : t.emailsAdmin.domains.emptyTitle}
              </p>
              <Button variant="secondary" size="sm" asChild>
                <Link href={emptyHref} scroll={false}>
                  {emptyDomain
                    ? t.emailsAdmin.panel.tabs.mailboxes
                    : t.emailsAdmin.overview.addDomain}
                </Link>
              </Button>
            </div>
          )
        ))}
      </section>
      {renderSidebar(domainSwitch)}
    </>
  );
}
