"use client";

import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import type { BillingState } from "@/lib/api/billing";
import { isNewCloudCustomer } from "@/lib/billing-presentation";
import { CloudPlanIllustration } from "./CloudPlanIllustration";

/** First-subscription offer; existing customers manage their plan in Billing. */
export function CloudHomePlanCard({ state }: { state: BillingState | null }) {
  const { t } = useI18n();
  const copy = t.billing.home;

  if (!state || !isNewCloudCustomer(state) || state.complimentary || state.billing?.enabled !== true) {
    return null;
  }

  return (
    <section
      aria-label={copy.label}
      className="overflow-hidden rounded-2xl bg-card p-5"
      style={{ backgroundImage: "radial-gradient(ellipse at 100% 0%, color-mix(in oklab, var(--th-btn-accent-to) 7%, transparent), transparent 65%)" }}
    >
      <p className="text-sm font-medium text-muted-foreground">{copy.label}</p>
      <CloudPlanIllustration className="mx-auto mb-3 mt-2 w-48" />
      <h2 className="text-lg font-medium tracking-tight text-foreground/85">
        {copy.title}
      </h2>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
        {copy.description}
      </p>
      <Button
        asChild
        variant="secondary"
        className="mt-4 h-10 w-full text-foreground/80 hover:brightness-105"
        style={{ background: "linear-gradient(110deg, color-mix(in oklab, var(--th-btn-accent-from) 14%, var(--th-card-on-page)), color-mix(in oklab, var(--th-btn-accent-to) 10%, var(--th-card-on-page)))" }}
      >
        <Link href="/billing/plans">
          {copy.viewPlans}
          <Icon name="arrow-right" className="size-4 rtl:rotate-180" aria-hidden="true" />
        </Link>
      </Button>
    </section>
  );
}
