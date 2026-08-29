"use client";

import { AlertTriangle } from "lucide-react";
import { BadgeTooltip } from "./BadgeTooltip";

/**
 * "Unverified" chip for a CUSTOM app — one this org uploaded as JSON, so its
 * images and pipeline are the operator's own rather than a reviewed catalog entry.
 * Hover carries the trust warning.
 *
 * Keyed on `custom` (provenance), NEVER on `!verified`. Those are different
 * questions: a curated entry that hasn't been boot-verified yet still ships an
 * official upstream image from our own repo, and telling its installer "it deploys
 * images you provided" is simply false — that copy was appearing on Neon and
 * PostHog. `custom` is server-set (catalog-source stamps it on the org's uploaded
 * rows) and deliberately not authorable, so an upload can't claim otherwise.
 *
 * Same reason as {@link HostingBadge}: this was a full-width warning banner above
 * the form, and two stacked banners buried the wizard's actual content.
 */
export function UnverifiedBadge({ className = "" }: { className?: string }) {
  return (
    <BadgeTooltip
      className={`shrink-0 ${className}`}
      align="end"
      trigger={
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
          <AlertTriangle className="size-3" aria-hidden /> Unverified
        </span>
      }
      title={
        <>
          <AlertTriangle className="size-3.5 text-warning" /> Custom app — not verified
        </>
      }
    >
      It deploys images you provided, not an official reviewed app. Review the definition and only
      install apps you trust.
    </BadgeTooltip>
  );
}
