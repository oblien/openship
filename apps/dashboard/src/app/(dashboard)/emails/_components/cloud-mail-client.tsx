"use client";

import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";

/** Cloud's mail entry point uses the ordinary catalog app installer. Mail
 * administration APIs stay local-only; this surface never probes them. */
export function CloudMailClient() {
  const { t } = useI18n();
  const copy = t.emails.cloudClient;
  const managed = t.emails.cloudComingSoon;
  return (
    <PageContainer>
      <header className="mb-6">
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{copy.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{copy.subtitle}</p>
      </header>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="flex flex-col items-center rounded-2xl bg-card px-5 py-10 text-center sm:px-8 sm:py-12">
          <svg
            aria-hidden="true"
            viewBox="0 0 240 130"
            className="mb-7 w-60 max-w-full text-muted-foreground"
            fill="none"
          >
            <path
              d="M49 65H191"
              stroke="currentColor"
              strokeOpacity=".25"
              strokeWidth="1.5"
              strokeDasharray="4 5"
            />
            <rect x="14" y="36" width="52" height="58" rx="12" fill="var(--th-on-05)" />
            <rect
              x="28"
              y="49"
              width="24"
              height="30"
              rx="4"
              stroke="currentColor"
              strokeOpacity=".7"
              strokeWidth="1.5"
            />
            <path
              d="M34 56H46M34 62H46"
              stroke="currentColor"
              strokeOpacity=".7"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <circle cx="40" cy="72" r="1.5" fill="currentColor" fillOpacity=".7" />
            <rect x="77" y="20" width="86" height="90" rx="20" fill="var(--th-on-05)" />
            <rect
              x="95"
              y="46"
              width="50"
              height="37"
              rx="7"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M97 51L116 65C118.4 66.8 121.6 66.8 124 65L143 51"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <rect x="174" y="36" width="52" height="58" rx="12" fill="var(--th-on-05)" />
            <rect
              x="185"
              y="50"
              width="30"
              height="25"
              rx="4"
              stroke="currentColor"
              strokeOpacity=".7"
              strokeWidth="1.5"
            />
            <path
              d="M193 82H207M200 75V82"
              stroke="currentColor"
              strokeOpacity=".7"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <h2 className="text-xl font-medium text-foreground">{copy.connectTitle}</h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            {copy.description}
          </p>
          <Button asChild className="mt-6 h-auto min-h-10 max-w-full whitespace-normal">
            <Link href="/apps/new/webmail">
              <Icon name="plug" />
              <span>{copy.connectAction}</span>
            </Link>
          </Button>
          <p className="mt-4 max-w-md text-xs leading-relaxed text-muted-foreground">
            {copy.signInHint}
          </p>
          <Button
            asChild
            variant="link"
            size="sm"
            className="mt-2 h-auto min-h-8 max-w-full whitespace-normal"
          >
            <Link href="/apps">
              <Icon name="grid" />
              <span>{copy.manageAction}</span>
            </Link>
          </Button>
        </section>
        <aside className="rounded-2xl bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-foreground">{managed.title}</h2>
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
              {managed.badge}
            </span>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            {managed.description}
          </p>
        </aside>
      </div>
    </PageContainer>
  );
}
