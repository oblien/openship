"use client";

import { ServerBillingPicker, billingServersVisible, useBillingServerInventory } from "@/components/billing/ServerBillingPicker";

export function BillingContent({
  children,
  sidebar,
  layout = "details",
}: {
  children: React.ReactNode;
  sidebar: React.ReactNode | null;
  layout?: "details" | "plans" | "purchase";
}) {
  const inventory = useBillingServerInventory();
  // Plans keep the whole comparison width. Usage and history retain the
  // visible server list; purchasing another server has no selected subscription.
  const showServers = billingServersVisible(inventory);
  if (layout !== "details") return <div className="min-w-0 space-y-5">{children}</div>;
  if (!sidebar && !showServers) {
    return <div className="min-w-0">{children}</div>;
  }

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="order-2 min-w-0 lg:order-1">{children}</div>
      <aside className="order-1 min-w-0 space-y-4 lg:sticky lg:top-6 lg:order-2">
        {showServers && <ServerBillingPicker />}
        {sidebar}
      </aside>
    </div>
  );
}
