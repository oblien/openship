"use client";

import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { formatMilliCredits } from "@/lib/billing-usage";
import type { ApiPlan } from "./PricingCards";
import { planCapacity } from "./plan-presentation";

/** Keep the charging rule visible once; exact credit allowances can be expanded. */
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
  const metered = plans.filter((plan) => plan.id !== "free" && plan.id !== "enterprise");
  if (!metered.length) return null;
  return (
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
  );
}
