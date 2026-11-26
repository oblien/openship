import { useId, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { instanceOrigin } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/i18n-provider";

export function MailWelcomeCard({ title, description, children }: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="@container overflow-hidden rounded-2xl bg-card">
      <div className="grid @min-[44rem]:grid-cols-[1fr_1.1fr]">
        <div className="flex flex-col items-start justify-center px-6 py-8 @min-[38rem]:px-9 @min-[38rem]:py-12">
          <FeatureIllustration name="mail" className="illustration-color mb-4 h-auto w-16" />
          <h2 className="text-3xl font-medium tracking-tight sm:text-4xl">{title}</h2>
          <p className="mt-3 max-w-sm text-pretty leading-relaxed text-muted-foreground">
            {description}
          </p>
          {children}
        </div>
        <a href="/mail/inbox-preview.webp" target="_blank" rel="noopener noreferrer"
          aria-label={t.emails.cloudClient.previewInbox}
          className="group relative isolate min-h-52 overflow-hidden bg-muted/45 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring @min-[38rem]:min-h-64">
          <span className="absolute start-6 top-4 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground group-hover:text-foreground @min-[44rem]:start-8 @min-[44rem]:top-5">
            {t.emails.cloudClient.previewInbox}<Icon name="arrow-up-right" className="size-3.5" />
          </span>
          <picture>
            <source media="(max-width: 639px)" srcSet="/mail/inbox-mobile-preview.webp" />
            <Image
              src="/mail/inbox-preview.webp"
              alt={t.emails.cloudClient.inboxPreview}
              width={2464}
              height={1360}
              sizes="(min-width:1024px) 50vw, 95vw"
              priority
              className="absolute start-6 top-12 w-[92%] max-w-none rounded-xl border border-border/80 shadow-xl @min-[38rem]:w-[125%] @min-[44rem]:start-8 @min-[44rem]:top-14"
            />
          </picture>
        </a>
      </div>
    </section>
  );
}

export function CloudMailAccess({
  plansHref,
  connectHref,
  pending,
}: {
  plansHref: string;
  connectHref: string;
  pending?: boolean;
}) {
  const { t } = useI18n();
  const c = t.emails.cloudClient;
  return (
    <MailWelcomeCard title="OpenShip Mail" description={c.accessIntro}>
      <div className="mt-6 flex flex-wrap gap-2.5">
        <Button asChild>
          <Link href={plansHref}>
            {pending ? c.resumeCheckout : c.browsePlans}
            <Icon name="arrow-right" className="rtl:rotate-180" />
          </Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href={connectHref}>{c.connectTitle}</Link>
        </Button>
      </div>
    </MailWelcomeCard>
  );
}

function instanceMailHref(input: string) {
  const address = input.trim();
  if (!address || /[\s\\]/.test(address) || address.startsWith("/")) return null;
  try {
    const url = new URL(address.includes("://") ? address : "https://" + address);
    if (url.pathname === "/emails" || url.pathname === "/emails/") url.pathname = "/";
    if (url.pathname !== "/") return null;
    return instanceOrigin(url.href) + "/emails";
  } catch {
    return null;
  }
}

export function ExistingMailConnection() {
  const { t } = useI18n();
  const c = t.emails.cloudClient;
  const id = useId();
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);
  function open(event: FormEvent) {
    event.preventDefault();
    const href = instanceMailHref(address);
    if (!href || new URL(href).origin === window.location.origin) {
      setInvalid(true);
      return;
    }
    window.location.assign(href);
  }
  return (
    <section className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <form onSubmit={open} className="space-y-4 rounded-2xl bg-card p-6">
        <h2 className="text-xl font-medium">{c.instanceTitle}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{c.instanceHint}</p>
        <label htmlFor={id} className="block text-sm font-medium">
          {c.dashboardAddress}
        </label>
        <Input
          id={id}
          dir="ltr"
          value={address}
          variant="filled"
          placeholder="https://dashboard.example.com"
          required
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={invalid}
          aria-describedby={invalid ? id + "-error" : undefined}
          onChange={(e) => {
            setAddress(e.target.value);
            setInvalid(false);
          }}
        />
        {invalid && (
          <p role="alert" id={id + "-error"} className="text-sm text-destructive">
            {c.invalidAddress}
          </p>
        )}
        <Button type="submit">
          {c.openDashboard}
          <Icon name="arrow-up-right" />
        </Button>
      </form>
      <section className="space-y-3 rounded-2xl border border-border/50 p-6">
        <Icon name="inbox" className="size-5 text-muted-foreground" />
        <h2 className="text-lg font-medium">{c.otherProvider}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{c.subtitle}</p>
        <Button variant="secondary" asChild>
          <Link href="/apps/new/webmail">{c.connectImap}</Link>
        </Button>
      </section>
    </section>
  );
}
