import React from "react";

/**
 * Migrations empty-state illustration — source server, a dashed flight path
 * carrying container blocks, and a target server where the first unit has
 * already landed. The shield restates the promise the copy makes: the source
 * keeps its units, nothing is torn down.
 *
 * Same construction as {@link ProjectIllustration}: one flat SVG, every colour
 * from a `--th-*` token so it tracks light / dark / dim with no per-theme
 * branching. Surfaces use `--th-sf-*` rather than `--th-card-bg` on purpose —
 * this sits ON a card, and the card fill would render it invisible.
 */
export function MigrationIllustration({ className }: { className?: string }) {
  return (
    <div className={className ?? "relative mx-auto h-32 w-72"}>
      {/* viewBox is cropped to the real content bounds (y 26.5–149, x 7.5–293.5)
          rather than a round 300×170 — the leftover band was showing up as dead
          space between the shield and the heading below it. */}
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="4 22 292 132"
        fill="none"
        aria-hidden="true"
      >
        {/* ── Source server ── full, this is what you already run ── */}
        <rect x="22" y="48" width="82" height="78" rx="14" fill="var(--th-sf-05)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
        <rect x="22" y="48" width="82" height="20" rx="10" fill="var(--th-sf-08)" />
        <circle cx="36" cy="58" r="2.5" fill="var(--th-on-20)" />
        <circle cx="45" cy="58" r="2.5" fill="var(--th-on-12)" />
        <rect x="34" y="78" width="58" height="8" rx="3" fill="var(--th-on-16)" />
        <rect x="34" y="92" width="58" height="8" rx="3" fill="var(--th-on-12)" />
        <rect x="34" y="106" width="58" height="8" rx="3" fill="var(--th-on-10)" />

        {/* ── Target server ── waiting, one unit landed ── */}
        <rect x="196" y="48" width="82" height="78" rx="14" fill="var(--th-sf-03)" stroke="var(--th-bd-default)" strokeWidth="1" />
        <rect x="196" y="48" width="82" height="20" rx="10" fill="var(--th-sf-05)" />
        <circle cx="210" cy="58" r="2.5" fill="var(--th-on-12)" />
        <rect x="208" y="78" width="58" height="8" rx="3" fill="var(--th-on-16)" />
        <rect x="208" y="92" width="58" height="8" rx="3" fill="none" stroke="var(--th-on-10)" strokeWidth="1" strokeDasharray="3 3" />
        <rect x="208" y="106" width="58" height="8" rx="3" fill="none" stroke="var(--th-on-10)" strokeWidth="1" strokeDasharray="3 3" />

        {/* ── Flight path ── dashed: data is in transit, not yet committed ── */}
        <path d="M104 84 C130 46 172 46 196 84" stroke="var(--th-on-16)" strokeWidth="1.5" strokeDasharray="5 5" strokeLinecap="round" />

        {/* Container units riding the path, brightening as they arrive.
            Positions are the cubic evaluated at t = .25 / .5 / .75. */}
        <rect x="119.5" y="56" width="13" height="13" rx="4" fill="var(--th-on-10)" />
        <rect x="144.3" y="49" width="13" height="13" rx="4" fill="var(--th-on-16)" />
        <rect x="168.7" y="56" width="13" height="13" rx="4" fill="var(--th-on-30)" />

        {/* ── Non-destructive shield ── */}
        <path d="M150 126 L158 129 L158 136 Q158 142.5 150 145.5 Q142 142.5 142 136 L142 129 Z" fill="var(--st-success-bg)" stroke="var(--st-success-fg)" strokeWidth="1.1" />
        <path d="M146.4 135.4 L149.4 138.2 L153.8 132.6" stroke="var(--st-success-fg)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />

        {/* ── Decorative flecks ── */}
        <circle cx="11" cy="30" r="3.5" fill="var(--th-on-10)" />
        <circle cx="291" cy="36" r="2.5" fill="var(--th-on-12)" />
        <circle cx="288" cy="142" r="4" fill="var(--th-on-08)" />
        <circle cx="13" cy="146" r="3" fill="var(--th-on-06)" />
        <path d="M117 118 l1.6-3.2 1.6 3.2-3.2-1.6 3.2 0-3.2 1.6z" fill="var(--th-on-16)" />
        <path d="M182 34 l1.4-2.8 1.4 2.8-2.8-1.4 2.8 0-2.8 1.4z" fill="var(--th-on-12)" />
      </svg>
    </div>
  );
}

export default MigrationIllustration;
