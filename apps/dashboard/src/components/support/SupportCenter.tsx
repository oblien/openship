"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BRAND_LINKS, SUPPORT_EMAIL } from "@repo/core";
import type { CloudSupportCategory } from "@repo/contracts";
import { Icon, type IconName } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/PageContainer";
import { canUseCloudConnection, usePlatform } from "@/context/PlatformContext";
import { useAuth } from "@/context/AuthContext";
import { createCloudSupportApi, type CloudSupportApi } from "@/lib/api/cloud-support";
import { NewSupportTicket } from "./NewSupportTicket";
import { SupportConversation } from "./SupportConversation";
import { SupportTicketList } from "./SupportTicketList";
import { supportTicketHref } from "./support-shared";
import { SupportApiProvider } from "./support-api";
import { LinkedSupportCenter } from "./LinkedSupportCenter";

const topics: { category: CloudSupportCategory; icon: IconName }[] = [
  { category: "deployment", icon: "rocket" },
  { category: "billing", icon: "credit-card" },
  { category: "account", icon: "user" },
  { category: "general", icon: "help-circle" },
];

export function SupportCenter() {
  const platform = usePlatform();
  const { user, isLoading } = useAuth();
  const { t } = useI18n();
  const client = useMemo(() => createCloudSupportApi(user?.id), [user?.id]);
  if (canUseCloudConnection(platform))
    return (
      <LinkedSupportCenter key={`${user?.id ?? "local"}:${platform.cloudApiUrl}`}>
        {(account, linkedClient) => (
          <CustomerSupport key={account.key} email={account.email} client={linkedClient} linked />
        )}
      </LinkedSupportCenter>
    );
  if (!user)
    return (
      <PageContainer>
        <p role="status" className="text-sm text-muted-foreground">
          {isLoading ? t.support.loading : t.support.signIn}
        </p>
      </PageContainer>
    );
  // Clear private data and ignore unfinished work when the signed-in account changes.
  return <CustomerSupport key={user.id} email={user.email} client={client} />;
}

function CustomerSupport({
  email,
  client,
  linked = false,
}: {
  email: string;
  client: CloudSupportApi;
  linked?: boolean;
}) {
  const { t } = useI18n();
  const copy = t.support;
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = params.get("ticket");
  const composing = params.get("new") === "1";
  const topic = topics.find((item) => item.category === params.get("topic"))?.category ?? "general";
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((value) => value + 1), []);
  const hasDetail = composing || Boolean(selectedId);

  return (
    <SupportApiProvider value={client}>
      <PageContainer className="@container space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 max-w-full items-center gap-3.5">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-card text-muted-foreground">
              <Icon name="help-circle" className="size-6" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{copy.subtitle}</p>
              {linked && (
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {interpolate(copy.linkedAs, { email })}
                </p>
              )}
            </div>
          </div>
          {!composing && (
            <Button asChild>
              <Link href="/support?new=1" scroll={false}>
                <Icon name="plus" className="size-4" aria-hidden="true" />
                {copy.newTicket}
              </Link>
            </Button>
          )}
        </header>
        <div className="grid items-start gap-6 @[820px]:grid-cols-[320px_minmax(0,1fr)]">
          <div className={`min-w-0 ${hasDetail ? "hidden @[820px]:block" : ""}`}>
            <SupportTicketList selectedId={composing ? null : selectedId} revision={revision} />
          </div>
          <div className="min-w-0">
            {hasDetail && (
              <Button asChild variant="ghost" size="sm" className="mb-4 @[820px]:hidden">
                <Link href="/support" scroll={false}>
                  <Icon name="arrow-left" className="size-4 rtl:rotate-180" aria-hidden="true" />
                  {copy.back}
                </Link>
              </Button>
            )}
            {composing ? (
              <NewSupportTicket
                key={`new:${topic}`}
                initialCategory={topic}
                email={email}
                onCreated={(id) => {
                  changed();
                  router.replace(supportTicketHref(id), { scroll: false });
                }}
              />
            ) : selectedId ? (
              <SupportConversation key={selectedId} ticketId={selectedId} onChanged={changed} />
            ) : (
              <>
                <section className="rounded-2xl bg-card p-5 sm:p-8">
                  <span className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Icon name="mail" className="size-6" aria-hidden="true" />
                  </span>
                  <h2 className="text-xl font-semibold tracking-tight">{copy.selectTitle}</h2>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {copy.selectDescription}
                  </p>
                  <div className="mt-6 grid gap-3 @[540px]:grid-cols-2">
                    {topics.map(({ category, icon }) => (
                      <Link
                        key={category}
                        href={`/support?new=1&topic=${category}`}
                        scroll={false}
                        className="group flex items-center gap-3 rounded-xl bg-muted/40 p-4 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <Icon
                          name={icon}
                          className="size-5 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">{copy.categories[category]}</span>
                        <Icon
                          name="arrow-right"
                          className="size-4 text-muted-foreground/50 rtl:rotate-180"
                          aria-hidden="true"
                        />
                      </Link>
                    ))}
                  </div>
                </section>
                <section
                  className="mt-6 rounded-2xl bg-card p-5 sm:p-6"
                  aria-labelledby="support-resources"
                >
                  <h2 id="support-resources" className="mb-4 text-sm font-semibold">
                    {copy.resourcesTitle}
                  </h2>
                  <div className="grid gap-4 @[540px]:grid-cols-2">
                    {[
                      {
                        href: BRAND_LINKS.docs,
                        title: copy.docsTitle,
                        description: copy.docsDescription,
                        icon: "file-text" as const,
                      },
                      {
                        href: BRAND_LINKS.community,
                        title: copy.communityTitle,
                        description: copy.communityDescription,
                        icon: "users" as const,
                      },
                    ].map((resource) => (
                      <a
                        key={resource.href}
                        href={resource.href}
                        target="_blank"
                        rel="noreferrer"
                        className="group flex items-start gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <Icon
                          name={resource.icon}
                          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span>
                          <span className="text-sm font-medium group-hover:underline">
                            {resource.title}
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            {resource.description}
                          </span>
                        </span>
                      </a>
                    ))}
                  </div>
                </section>
              </>
            )}
            <div className="mt-5 flex flex-wrap items-start justify-between gap-3 px-1 text-xs leading-5 text-muted-foreground">
              <p className="flex max-w-md items-start gap-2">
                <Icon name="shield-check" className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {copy.privateHint}
              </p>
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="shrink-0 underline-offset-4 hover:underline"
              >
                {copy.emailSupport}
              </a>
            </div>
          </div>
        </div>
      </PageContainer>
    </SupportApiProvider>
  );
}
