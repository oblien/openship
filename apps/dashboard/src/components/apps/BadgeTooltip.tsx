"use client";

import type { ReactNode } from "react";

/**
 * Hover panel for the small trust / hosting chips on catalog cards and the install
 * wizard: the chip stays a one-word mark and the paragraph explaining it lives on
 * hover. One implementation shared by all of them (Verified, Experimental,
 * Unverified) — three copies of the rules below would drift, and the wizard header
 * is where they sit side by side.
 *
 * CSS-only — no state, no dependency — and the trigger is non-interactive, so a
 * chip using this is safe inside the catalog card's own `<button>`.
 *
 * Frosted-glass surface (`bg-popover/85` + `backdrop-blur-xl`): `bg-card` is only
 * rgba(255,255,255,.025) in the dark themes, so text underneath used to read
 * straight through an opaque-looking panel.
 *
 * CRITICAL, same rule as the notifications dropdown: the element carrying
 * `backdrop-blur` is NEVER given an opacity animation — an element with
 * opacity < 1 stops rendering its own backdrop-filter, so fading the panel itself
 * would flash the blur off for the whole transition. The panel only
 * scales/translates in (blur-safe) and `visibility` is transitioned so it stays
 * painted while the content fades out; the fade lives on the inner wrapper, where
 * a child's opacity can't reach the parent's backdrop-filter.
 */
export function BadgeTooltip({
  trigger,
  title,
  children,
  className = "",
  align = "center",
}: {
  /** The always-visible chip or icon. */
  trigger: ReactNode;
  /** Bold first line of the panel — usually the chip's own words + its icon. */
  title: ReactNode;
  /** The explanation. */
  children: ReactNode;
  className?: string;
  /** `end` anchors the panel's trailing edge to the chip, for a chip sitting at
   *  the right edge of a card where a centred panel would spill out of it. */
  align?: "center" | "end";
}) {
  return (
    <span className={`group/bt relative inline-flex items-center ${className}`}>
      {trigger}
      <span
        role="tooltip"
        className={`pointer-events-none invisible absolute top-full z-30 mt-2 w-60 translate-y-1 scale-95 rounded-xl border border-border/60 bg-popover/85 px-3 py-2.5 text-start shadow-xl shadow-black/20 backdrop-blur-xl transition-[transform,visibility] duration-150 group-hover/bt:visible group-hover/bt:translate-y-0 group-hover/bt:scale-100 ${
          align === "end" ? "end-0" : "left-1/2 -translate-x-1/2"
        }`}
      >
        <span className="block text-[11px] normal-case leading-relaxed tracking-normal text-muted-foreground opacity-0 transition-opacity duration-200 group-hover/bt:opacity-100">
          <span className="mb-1 flex items-center gap-1.5 font-semibold text-foreground">
            {title}
          </span>
          {children}
        </span>
      </span>
    </span>
  );
}
