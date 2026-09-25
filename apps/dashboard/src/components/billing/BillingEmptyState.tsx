"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import Link from "next/link";
import { useI18n } from "@/components/i18n-provider";

export function BillingEmptyState({ kind }: { kind: "usage" | "payment" | "invoices" | "topups" }) {
  const { t } = useI18n();
  const copy = t.billing.onboarding;
  const { Icon, title, description } = {
    usage: { Icon: "chart-bar" as const, title: copy.usageTitle, description: copy.usageDescription },
    payment: { Icon: "credit-card" as const, title: copy.paymentTitle, description: copy.paymentDescription },
    invoices: { Icon: "receipt" as const, title: copy.invoicesTitle, description: copy.invoicesDescription },
    topups: { Icon: "coins" as const, title: copy.topupsTitle, description: copy.topupsDescription },
  }[kind];
  return <section className="flex min-h-80 flex-col items-center justify-center rounded-2xl bg-card px-6 py-12 text-center">
    <span className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-muted/50 text-muted-foreground"><UiIcon name={Icon} className="size-5" aria-hidden="true" /></span>
    <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
    <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
    <Link href="/billing/plans" className="mt-6 inline-flex items-center gap-2 rounded-xl border border-border/60 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/40">
      {copy.choosePlan}<UiIcon name="arrow-right" className="size-4 rtl:rotate-180" aria-hidden="true" />
    </Link>
  </section>;
}
