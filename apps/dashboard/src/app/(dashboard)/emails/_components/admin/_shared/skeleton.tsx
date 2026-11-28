"use client";

/**
 * Pulsing placeholder primitive. Use whenever a network call is loading
 * to keep the layout stable - no spinners, no "Loading…" text, just the
 * shape of what's about to land.
 *
 * Matches the rest of the dashboard's loading pattern (DashboardHomeClient
 * uses `animate-pulse` + `bg-muted` rectangles for the same purpose).
 */

import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("motion-safe:animate-pulse rounded-md bg-muted", className)}
      aria-hidden="true"
    />
  );
}

/**
 * Standard row-skeleton for any per-row list (mailbox, domain, alias).
 * One 40px avatar block, two stacked text lines, and a couple of right-
 * aligned chips. Matches the layout of the real row so the page doesn't
 * shift when data arrives.
 */
export function ListRowSkeleton() {
  return (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <Skeleton className="w-10 h-10 rounded-xl shrink-0" />
      <div className="flex-1 min-w-0 space-y-2">
        <Skeleton className="h-3 w-44" />
        <Skeleton className="h-2.5 w-72 max-w-full" />
      </div>
      <Skeleton className="h-5 w-16 rounded-full shrink-0" />
    </div>
  );
}
