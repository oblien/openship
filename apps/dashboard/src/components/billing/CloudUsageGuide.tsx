"use client";

import { Clock3, Cpu, Layers3 } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

/** The same explanation on pricing and billing. Credits pay for resources;
 * build minutes and concurrent services are independent plan limits. */
export function CloudUsageGuide({ collapsible = false }: { collapsible?: boolean }) {
  const { t } = useI18n();
  const copy = t.billing.resourcesGuide;
  const explanation = <>
      <div className="mt-4 grid gap-5 md:grid-cols-3">
        {[
          { Icon: Cpu, title: copy.usageAllowance, text: copy.usageSummary },
          { Icon: Clock3, title: copy.buildTime, text: copy.buildHint },
          { Icon: Layers3, title: copy.apps, text: copy.appsHint },
        ].map(({ Icon, title, text }) => (
          <div key={title}>
            <div className="flex items-center gap-2 text-sm font-medium"><Icon className="size-4 text-muted-foreground" aria-hidden="true" />{title}</div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>
      <p className="mt-4 border-t border-border/50 pt-3 text-xs leading-relaxed text-muted-foreground">{copy.balanceRule}</p>
  </>;
  return collapsible ? (
    <details className="rounded-xl bg-muted/30 p-4">
      <summary className="cursor-pointer text-sm font-medium text-foreground">{copy.title}</summary>
      {explanation}
    </details>
  ) : (
    <div className="rounded-xl bg-muted/30 p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-foreground">{copy.title}</h3>
      {explanation}
    </div>
  );
}
