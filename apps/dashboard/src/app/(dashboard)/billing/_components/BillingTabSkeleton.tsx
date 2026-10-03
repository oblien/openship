"use client";

import { usePathname } from "next/navigation";
import { useI18n } from "@/components/i18n-provider";

function Shimmer({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`motion-safe:animate-pulse rounded-lg bg-muted/60 ${className}`}
    />
  );
}

export function BillingPlansSkeleton() {
  const { t } = useI18n();
  return (
    <div
      role="status"
      aria-label={t.billing.usage.breakdown.loading}
      className="@container/pricing"
    >
      <div className="grid gap-4 @min-[34rem]/pricing:grid-cols-2 @min-[70rem]/pricing:grid-cols-4">
        {[1, 2, 3, 4].map((item) => (
          <div key={item} className="space-y-4 rounded-2xl bg-card p-5">
            <Shimmer className="h-5 w-24" />
            <Shimmer className="h-8 w-28" />
            <Shimmer className="h-10 w-full" />
            <Shimmer className="h-10 w-full" />
            <Shimmer className="h-16 w-full" />
            {[1, 2, 3, 4].map((row) => (
              <Shimmer key={row} className="h-4 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BillingTabSkeleton() {
  const pathname = usePathname();
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t.billing.usage.breakdown.loading}>
      {pathname.endsWith("/plans") ? (
        <BillingPlansSkeleton />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="@container/skeleton space-y-4 rounded-2xl bg-card p-5">
            <Shimmer className="h-5 w-36" />
            <Shimmer className="h-4 w-64 max-w-full" />
            <div className="grid gap-3 @min-[28rem]/skeleton:grid-cols-2">
              {[1, 2, 3, 4].map((item) => (
                <div key={item} className="flex items-center gap-3 rounded-xl bg-muted/30 p-3">
                  <Shimmer className="size-10 shrink-0 rounded-full" />
                  <div className="space-y-2">
                    <Shimmer className="h-3 w-20" />
                    <Shimmer className="h-6 w-24" />
                  </div>
                </div>
              ))}
            </div>
            <Shimmer className="h-16 w-full rounded-xl" />
          </div>
          <div className="space-y-4 rounded-2xl bg-card p-5">
            <Shimmer className="h-4 w-24" />
            <Shimmer className="h-6 w-36" />
            <Shimmer className="h-8 w-20" />
            <Shimmer className="h-16 w-full rounded-xl" />
            <Shimmer className="h-10 w-full rounded-xl" />
          </div>
        </div>
      )}
    </div>
  );
}
