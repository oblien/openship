"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { BillingLink as Link } from "@/components/billing/BillingWorkspaceContext";
import { useI18n } from "@/components/i18n-provider";
import { BILLING_TABS, type BillingTab } from "./billing-tabs";

export function BillingTabBar({ activeTab, plansOnly = false, loading = false }: {
  activeTab: BillingTab;
  plansOnly?: boolean;
  loading?: boolean;
}) {
  const { t } = useI18n();

  if (loading) return (
    <div aria-hidden="true" className="flex h-12 items-center gap-4 border-b border-border/50 px-3 sm:px-4">
      <span className="h-4 w-28 rounded-md bg-muted/60 motion-safe:animate-pulse" />
    </div>
  );

  return (
    <nav
      aria-label={t.billing.layout.title}
      className="flex items-center gap-1 overflow-x-auto border-b border-border/50"
    >
      {BILLING_TABS.filter(tab => !plansOnly || tab.key === "plans").map((tab) => {
        const Icon = tab.icon;
        const active = activeTab === tab.key;

        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-lg px-3 py-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-4 ${
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
            }`}
          >
            <UiIcon name={Icon} className="size-4" />
            {t.billing.tabs[tab.key]}
            {active && (
              <span className="absolute bottom-0 start-0 end-0 h-0.5 rounded-full bg-primary" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
