"use client";

import { Icon } from "@repo/ui/icons";
import { resolveStandard, toPricingLocale } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { formatMilliCredits } from "@/lib/billing-usage";
import type { ApiPlan } from "./PricingCards";
import { planCapacity } from "./plan-presentation";

/** Shared plan benefits, with additional billing terms available on demand. */
export function PlanUsageNote({
  plans,
  interval = "monthly",
  workspaceScoped = false,
  showCapacityNote = true,
}: {
  plans: ApiPlan[];
  interval?: "monthly" | "annual";
  workspaceScoped?: boolean;
  showCapacityNote?: boolean;
}) {
  const { t, locale } = useI18n();
  const copy = t.billing.resourcesGuide;
  const standard = resolveStandard(toPricingLocale(locale));
  const paid = plans.filter((plan) => plan.id !== "free" && plan.id !== "enterprise");
  const metered = paid.filter((plan) => plan.billingMode !== "monthly");
  if (!paid.length) return null;
  const features = [
    ...(!metered.length
      ? [
          t.billing.compute.features.capacity,
          t.billing.compute.features.noCredits,
          t.billing.compute.features.shared,
          t.billing.compute.features.fullCapacity,
        ]
      : []),
    ...standard.features,
  ];
  return (
    <div className="@container/plan-details space-y-4">
      <section className="px-1">
        <h3 className="text-sm font-medium text-foreground">{standard.title}</h3>
        <ul className="mt-3 grid gap-x-6 gap-y-2 @min-[34rem]/plan-details:grid-cols-2 @min-[70rem]/plan-details:grid-cols-3">
          {features.map((feature) => (
            <li key={feature} className="flex items-start gap-2 text-sm text-muted-foreground">
              <Icon
                name="check"
                className="mt-1 size-3.5 shrink-0 text-primary"
                aria-hidden="true"
              />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
        {!metered.length && (
          <details className="group mt-3 text-xs text-muted-foreground">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              {t.billing.compute.details}
              <Icon
                name="chevron-down"
                className="size-3.5 shrink-0 transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <p className="mt-2 max-w-4xl leading-relaxed">{t.billing.compute.extras}</p>
          </details>
        )}
      </section>
      {metered.length > 0 && (
        <aside
          role="note"
          className="space-y-2 rounded-2xl bg-card p-5 text-xs leading-relaxed text-muted-foreground"
        >
          <p>
            <span className="font-medium text-foreground">{copy.usageNote}</span> {copy.planUsageNote}
          </p>
          {showCapacityNote && metered.some((plan) => planCapacity(plan) !== null) && (
            <p>{workspaceScoped ? t.billing.workspaces.description : copy.poolNote}</p>
          )}
          <details className="group pt-1">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              {copy.creditAllowances}
              <Icon
                name="chevron-down"
                className="size-3.5 transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 tabular-nums">
              {metered.map((plan) => {
                const credits = interval === "annual" ? plan.annualCredits : plan.monthlyCredits;
                return (
                  <li key={plan.id}>
                    <bdi>{plan.name}</bdi>
                    {": "}
                    <bdi>{credits == null ? "—" : formatMilliCredits(credits, locale)}</bdi>
                  </li>
                );
              })}
            </ul>
          </details>
        </aside>
      )}
    </div>
  );
}
