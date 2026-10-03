"use client";

import { ServerBillingPicker, useBillingServerInventory } from "@/components/billing/ServerBillingPicker";

export function BillingContent({
  children,
  sidebar,
}: {
  children: React.ReactNode;
  sidebar: React.ReactNode | null;
}) {
  const inventory = useBillingServerInventory();
  // Unpurchased customers compare plans directly; existing servers remain
  // visible beside every billing tab, including the plan comparison.
  const showServers = Boolean(inventory && (inventory.error || inventory.servers.some(({ managed }) =>
    managed && (managed.resources || managed.planTierId !== "free" || managed.state !== "needs_plan"),
  )));
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
