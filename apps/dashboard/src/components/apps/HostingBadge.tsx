"use client";

import { FlaskConical } from "lucide-react";
import { BadgeTooltip } from "./BadgeTooltip";

/**
 * Honest "how is this hosted" chip for catalog cards + the install wizard.
 * `experimental` = self-host that runs but isn't production-grade
 * (heavy/unsupported). `self-hosted` (the default) renders nothing — it's the
 * norm, not worth the visual noise.
 *
 * The caveat is on HOVER, not in a banner. It used to be a full-width warning
 * block above the install form, which — stacked with the unverified one — made
 * two thirds of the wizard's first screen a yellow wall the operator scrolled
 * past. The chip is the signal; the paragraph is there when they want it.
 *
 * Uses the semantic status tokens (`warning`), never hardcoded colors.
 */
export function HostingBadge({
  hosting,
  className = "",
}: {
  hosting?: "self-hosted" | "experimental" | string;
  className?: string;
}) {
  if (hosting !== "experimental") return null;
  return (
    <BadgeTooltip
      className={`shrink-0 ${className}`}
      trigger={
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
          <FlaskConical className="size-3" aria-hidden /> Experimental
        </span>
      }
      title={
        <>
          <FlaskConical className="size-3.5 text-warning" /> Experimental self-host
        </>
      }
    >
      This runs the project&apos;s own self-host stack, which is heavy and not production-grade —
      the maintainers recommend their managed cloud for production. Great for trying it out or a
      hobby box.
    </BadgeTooltip>
  );
}
