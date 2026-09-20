"use client";

import { useSelectedLayoutSegment } from "next/navigation";

/**
 * Body of the billing layout. Wraps the active tab's children and an
 * optional sidebar slot, hiding the sidebar on the "plans" tab (the
 * plans grid wants the full content width). Client-side because the
 * sidebar visibility depends on the active layout segment.
 */
export function BillingContent({
  children,
  sidebar,
  promotePlan = false,
}: {
  children: React.ReactNode;
  sidebar: React.ReactNode | null;
  promotePlan?: boolean;
}) {
  const segment = useSelectedLayoutSegment();
  const showSidebar = sidebar !== null && segment !== "plans";

  if (!showSidebar) {
    return <div className="min-w-0">{children}</div>;
  }

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px] xl:gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">{children}</div>
      <aside className={`min-w-0 lg:sticky lg:top-6 ${promotePlan ? "order-first lg:order-last" : ""}`}>{sidebar}</aside>
    </div>
  );
}
