"use client";

/**
 * Country flag as an SVG, from `country-flag-icons` — the same source the servers
 * list and the connection card already use.
 *
 * Replaces the emoji flags this used to render. Emoji flags are regional-indicator
 * pairs, and **Windows has no glyphs for them at all** — every flag there degraded to
 * the two letters ("US", "DE"), so the column was decorative on macOS and broken
 * everywhere else. Reusing the existing dependency also means a flag looks identical
 * here and on the servers page instead of subtly different by platform.
 *
 * Falls back to the bare code rather than a blank: an unmapped or non-ISO value
 * (`other`, the donut's tail wedge) still needs to occupy the column so the rows stay
 * aligned.
 */

import React from "react";
import * as CountryFlags from "country-flag-icons/react/3x2";

const FLAGS = CountryFlags as Record<
  string,
  React.ComponentType<{ title?: string; className?: string }>
>;

export const CountryFlag: React.FC<{ code: string; title?: string }> = ({ code, title }) => {
  const Flag = /^[A-Z]{2}$/.test(code) ? FLAGS[code] : undefined;
  if (!Flag) {
    return (
      <span className="w-[18px] shrink-0 text-center text-[10px] font-medium text-muted-foreground">
        {code.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  // Hairline ring: a flag with white in it (JP, PL) otherwise bleeds into a light card.
  return (
    <Flag
      title={title ?? code}
      className="h-[13px] w-[18px] shrink-0 rounded-[2px] object-cover ring-1 ring-border/50"
    />
  );
};
