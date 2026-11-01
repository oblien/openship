"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { BadgeTooltip } from "./BadgeTooltip";

/**
 * Data-driven "Verified" trust mark (from `AppTemplate.verified`). Shown on
 * catalog cards + the install wizard. Hover reveals why the app is trusted —
 * official open-source image, version-pinned, reviewed pipeline. Use `text-info`
 * per the semantic status tokens.
 *
 * The hover panel (and the backdrop-blur rules it has to respect) lives in
 * {@link BadgeTooltip}, shared with the Experimental / Unverified chips.
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
    <BadgeTooltip
      className={className}
      trigger={<UiIcon name="verified" className={`${iconClassName} text-info`} aria-label="Verified app" />}
      title={
        <>
          <UiIcon name="verified" className="size-3.5 text-info" /> Verified app
        </>
      }
    >
      Uses the project&apos;s official, open-source image pinned to a version, deployed through a
      reviewed pipeline. The full definition is public and auditable.
    </BadgeTooltip>
  );
}
