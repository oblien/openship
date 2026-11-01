"use client";

import type { ReactNode } from "react";
import { CloudPurchaseTabs, useCloudPurchase } from "@/components/billing/CloudPurchaseContext";
import { ManagementBilling } from "@/components/billing/ManagementPlan";

/** Keep Cloud drafts mounted while the account's management subscription is open. */
export function BillingPurchaseContent({ children }: { children: ReactNode }) {
  const purchase = useCloudPurchase();
  if (!purchase.management) return children;
  const managing = purchase.mode === "manage";
  return (
    <div className="space-y-6">
      {purchase.tabs === "inline" && <CloudPurchaseTabs />}
      <div hidden={managing}>{children}</div>
      <div
        hidden={!managing}
        role="tabpanel"
        id={`${purchase.id}-panel-manage`}
        aria-labelledby={`${purchase.id}-tab-manage`}
      >
        {managing && <ManagementBilling onBusyChange={purchase.setBusy} />}
      </div>
    </div>
  );
}
