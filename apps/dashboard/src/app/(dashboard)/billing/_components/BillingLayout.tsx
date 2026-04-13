"use client";

import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { PageContainer } from "@/components/ui/PageContainer";
import { BILLING_TABS, BillingSidebar, MOCK_DATA, type BillingTab } from "./billing-shared";

export function BillingLayout({ children }: { children: React.ReactNode }) {
  const segment = useSelectedLayoutSegment();
  const activeTab = (segment && BILLING_TABS.some((tab) => tab.key === segment))
    ? (segment as BillingTab)
    : "overview";
  const showSidebar = activeTab !== "plans";

  return (
    <PageContainer className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
          Billing
        </h1>
        <p className="mt-1 text-sm text-muted-foreground/70">
          Manage your subscription, usage, and payment methods.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-border/50">
        {BILLING_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;

          return (
            <Link
              key={tab.key}
              href={tab.href}
              className={`relative inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
              }`}
            >
              <Icon className="size-4" />
              {tab.label}
              {active && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-primary" />
              )}
            </Link>
          );
        })}
      </div>

      {showSidebar ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
          <div className="min-w-0">{children}</div>
          <BillingSidebar billingData={MOCK_DATA} />
        </div>
      ) : (
        <div className="min-w-0">{children}</div>
      )}
    </PageContainer>
  );
}