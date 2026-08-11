"use client";

import { BadgeCheck } from "lucide-react";

/**
 * Data-driven "Verified" trust mark (from `AppTemplate.verified`). Shown on
 * catalog cards + the install wizard. Hover reveals why the app is trusted —
 * official open-source image, version-pinned, reviewed pipeline. CSS-only
 * tooltip (no dependency); the icon is non-interactive so it's safe inside the
 * card <button>. Use `text-info` per the semantic status tokens.
 *
 * Frosted-glass surface (`bg-popover/85` + `backdrop-blur-xl`) — `bg-card` is
 * only rgba(255,255,255,.025) in the dark themes, so the card text underneath
 * used to read straight through the panel.
 *
 * CRITICAL, same rule as the notifications dropdown: the element carrying
 * `backdrop-blur` is NEVER given an opacity animation — an element with
 * opacity < 1 stops rendering its own backdrop-filter, so fading the panel
 * itself would flash the blur off for the whole transition. The panel only
 * scales/translates in (blur-safe) and `visibility` is transitioned so it stays
 * painted while the content fades out; the fade lives on the inner wrapper,
 * where a child's opacity can't touch the parent's backdrop-filter.
 */
export function VerifiedBadge({
  className = "",
  iconClassName = "size-4",
}: {
  className?: string;
  /** Literal tailwind size class for the icon (must be a full class name). */
  iconClassName?: string;
}) {
  return (
    <span className={`group/vb relative inline-flex items-center ${className}`}>
      <BadgeCheck className={`${iconClassName} text-info`} aria-label="Verified app" />
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute left-1/2 top-full z-30 mt-2 w-60 -translate-x-1/2 translate-y-1 scale-95 rounded-xl border border-border/60 bg-popover/85 px-3 py-2.5 text-start shadow-xl shadow-black/20 backdrop-blur-xl transition-[transform,visibility] duration-150 group-hover/vb:visible group-hover/vb:translate-y-0 group-hover/vb:scale-100"
      >
        <span className="block text-[11px] normal-case leading-relaxed tracking-normal text-muted-foreground opacity-0 transition-opacity duration-200 group-hover/vb:opacity-100">
          <span className="mb-1 flex items-center gap-1.5 font-semibold text-foreground">
            <BadgeCheck className="size-3.5 text-info" /> Verified app
          </span>
          Uses the project&apos;s official, open-source image pinned to a version, deployed through
          a reviewed pipeline. The full definition is public and auditable.
        </span>
      </span>
    </span>
  );
}
