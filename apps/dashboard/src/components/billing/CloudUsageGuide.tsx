"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useI18n } from "@/components/i18n-provider";

/** Explain purchased capacity and measured usage using the saved billing mode. */
export function CloudUsageGuide({ collapsible = false, billingMode }: { collapsible?: boolean; billingMode?: "monthly" | "metered" | "payg" }) {
  const { t } = useI18n();
  const copy = t.billing.resourcesGuide;
  const monthly = billingMode === "monthly";
  const explanation = (
    <>
      <div className="mt-4 grid gap-4 @min-[38rem]/guide:grid-cols-3">
        {[
          { Icon: "cpu" as const, title: monthly ? t.billing.purchase.monthly : copy.usageAllowance, text: monthly ? t.billing.compute.included : copy.usageSummary },
          { Icon: "clock" as const, title: copy.buildTime, text: monthly ? t.billing.compute.buildHint : copy.buildHint },
          { Icon: "layers" as const, title: copy.apps, text: copy.appsHint },
        ].map(({ Icon, title, text }) => (
          <div key={title}>
            <div className="flex items-center gap-2 text-sm font-medium">
              <UiIcon name={Icon} className="size-4 text-muted-foreground" aria-hidden="true" />
              {title}
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>
      <p className="mt-4 border-t border-border/50 pt-3 text-xs leading-relaxed text-muted-foreground">
        {monthly ? t.billing.compute.extras : copy.balanceRule}
      </p>
    </>
  );
  return collapsible ? (
    <details className="@container/guide group rounded-2xl bg-card p-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        {copy.title}
        <UiIcon
          name="chevron-down"
          className="size-4 shrink-0 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      {explanation}
    </details>
  ) : (
    <div className="rounded-2xl bg-card p-5 sm:p-5">
      <h3 className="text-sm font-semibold text-foreground">{copy.title}</h3>
      {explanation}
    </div>
  );
}
