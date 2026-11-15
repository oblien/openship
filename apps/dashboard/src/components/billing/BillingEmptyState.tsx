"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { FeatureIllustration } from "@repo/ui/illustrations";

import { BillingLink as Link } from "@/components/billing/BillingWorkspaceContext";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";

export function BillingEmptyState({ kind }: { kind: "usage" | "payment" | "topups" }) {
  const { t } = useI18n();
  const copy = t.billing.onboarding;
  const { illustration, title, description } = {
    usage: {
      illustration: "logs-monitoring" as const,
      title: copy.usageTitle,
      description: copy.usageDescription,
    },
    payment: {
      illustration: "audit-log" as const,
      title: copy.paymentTitle,
      description: copy.paymentDescription,
    },
    topups: {
      illustration: "app-catalog" as const,
      title: copy.topupsTitle,
      description: copy.topupsDescription,
    },
  }[kind];
  return (
    <section className="flex min-h-60 flex-col items-center justify-center rounded-2xl bg-card p-6 text-center">
      <FeatureIllustration name={illustration} className="illustration-color mb-4 h-auto w-20" />
      <h2 className="text-base font-medium text-foreground">{title}</h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
      <Button asChild variant="secondary" className="mt-5">
        <Link href="/billing/plans">
          {copy.choosePlan}
          <UiIcon name="arrow-right" className="size-4 rtl:rotate-180" aria-hidden="true" />
        </Link>
      </Button>
    </section>
  );
}
