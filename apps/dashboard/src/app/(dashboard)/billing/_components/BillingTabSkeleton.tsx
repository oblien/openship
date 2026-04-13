"use client";

import { usePathname } from "next/navigation";

function Shimmer({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-muted ${className}`} />;
}

function OverviewSkeleton() {
  return (
    <div className="rounded-2xl border border-border/50 bg-card p-6">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Shimmer className="h-5 w-32" />
          <Shimmer className="h-4 w-64" />
        </div>
        <Shimmer className="h-9 w-28 rounded-xl" />
      </div>

      <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-6">
        {[1, 2, 3, 4, 5, 6].map((item) => (
          <div key={item} className="flex flex-col items-center gap-2">
            <Shimmer className="size-16 rounded-full" />
            <div className="w-full space-y-1.5 text-center">
              <Shimmer className="mx-auto h-4 w-12" />
              <Shimmer className="mx-auto h-3 w-16" />
              <Shimmer className="mx-auto h-3 w-14" />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-xl border border-border/50 p-4">
        <Shimmer className="h-4 w-72" />
      </div>
    </div>
  );
}

function PlansSkeleton() {
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-center gap-3">
        <Shimmer className="h-11 w-52 rounded-full" />
        <Shimmer className="h-6 w-20 rounded-full" />
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {[1, 2, 3].map((item) => (
          <div key={item} className="rounded-2xl border border-border/50 bg-card p-6">
            <div className="mb-6 space-y-3">
              <div className="flex items-center gap-2">
                <Shimmer className="size-9 rounded-xl" />
                <Shimmer className="h-5 w-24" />
              </div>
              <Shimmer className="h-4 w-40" />
            </div>

            <div className="mb-6 space-y-2">
              <Shimmer className="h-10 w-28" />
              <Shimmer className="h-3 w-24" />
            </div>

            <Shimmer className="mb-6 h-10 w-full rounded-xl" />

            <div className="space-y-3 border-t border-border/50 pt-5">
              <Shimmer className="h-3 w-24" />
              {[1, 2, 3, 4, 5].map((feature) => (
                <div key={feature} className="flex items-center gap-2.5">
                  <Shimmer className="size-4 rounded-full" />
                  <Shimmer className="h-4 flex-1" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      <div className="border-b border-border/50 p-5">
        <Shimmer className="h-5 w-36" />
        <Shimmer className="mt-2 h-4 w-64" />
      </div>

      <div className="space-y-3 p-5">
        {[1, 2, 3].map((row) => (
          <div key={row} className="flex items-center justify-between rounded-xl border border-border/50 px-4 py-4">
            <div className="flex items-center gap-3">
              <Shimmer className="size-10 rounded-lg" />
              <div className="space-y-1.5">
                <Shimmer className="h-4 w-24" />
                <Shimmer className="h-3 w-20" />
              </div>
            </div>
            <Shimmer className="h-8 w-20 rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BillingTabSkeleton() {
  const pathname = usePathname();

  if (pathname.endsWith("/plans")) {
    return <PlansSkeleton />;
  }

  if (pathname.endsWith("/payment") || pathname.endsWith("/invoices")) {
    return <PanelSkeleton />;
  }

  return <OverviewSkeleton />;
}