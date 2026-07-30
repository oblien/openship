import React from "react";

/**
 * Openship Cloud connect illustration — your instance on the left, the cloud on
 * the right, a dashed link carrying traffic between them, and a domain chip with
 * a lock for the free managed domain + automatic SSL.
 *
 * Same construction as {@link ProjectIllustration} and {@link MigrationIllustration}:
 * one flat SVG, every colour from a `--th-*` token so it tracks light / dark /
 * dim with no branching. Surfaces use `--th-sf-*` rather than `--th-card-bg` —
 * this sits ON a card, and the card fill would render it invisible.
 *
 * The domain chip is deliberately abstract (lock + two bars, no text): this ships
 * in nine locales and baked-in copy inside an SVG can't be translated.
 */
export function CloudIllustration({ className }: { className?: string }) {
  return (
    <div className={className ?? "relative mx-auto h-24 w-72"}>
      {/* Cropped to the content bounds so the card doesn't get padded out by an
          empty band under the artwork. */}
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="5 20 290 97"
        fill="none"
        aria-hidden="true"
      >
        {/* ── Your instance ── */}
        <rect x="22" y="48" width="78" height="66" rx="13" fill="var(--th-sf-05)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
        <rect x="22" y="48" width="78" height="18" rx="9" fill="var(--th-sf-08)" />
        <circle cx="35" cy="57" r="2.4" fill="var(--th-on-20)" />
        <circle cx="43.5" cy="57" r="2.4" fill="var(--th-on-12)" />
        <rect x="33" y="76" width="56" height="7" rx="3" fill="var(--th-on-16)" />
        <rect x="33" y="88" width="56" height="7" rx="3" fill="var(--th-on-12)" />
        <rect x="33" y="100" width="34" height="7" rx="3" fill="var(--th-on-10)" />

        {/* ── Cloud ── ONE path, not overlapping circles. The surface tokens are
            translucent white/black, so stacked shapes accumulate alpha and every
            overlap shows up as a brighter seam — a lumpy blob instead of a cloud.
            A single closed path composites once. */}
        <path
          d="M191 77 C179 77 176 62 192 56 C196 40 218 31 233 42 C240 36 252 38 255 48 C268 47 277 58 270 68 C274 71 275 75 274 77 Z"
          fill="var(--th-sf-06)"
        />

        {/* ── Link ── dashed: the connection is optional, not wired in yet ── */}
        <path d="M100 81 C130 81 158 74 189 72" stroke="var(--th-on-16)" strokeWidth="1.5" strokeDasharray="5 5" strokeLinecap="round" />
        <circle cx="132" cy="79.4" r="3" fill="var(--th-on-30)" />
        <circle cx="160" cy="75.8" r="2.4" fill="var(--th-on-20)" />

        {/* ── Free domain + automatic SSL ── */}
        <rect x="190" y="92" width="86" height="20" rx="10" fill="var(--th-sf-04)" />
        <path d="M203 100 v-2.4 a3 3 0 0 1 6 0 V100" stroke="var(--st-success-fg)" strokeWidth="1.2" strokeLinecap="round" />
        <rect x="201.5" y="99.6" width="9" height="7" rx="2" fill="var(--st-success-bg)" stroke="var(--st-success-fg)" strokeWidth="1.1" />
        <rect x="217" y="99" width="32" height="4.5" rx="2.25" fill="var(--th-on-30)" />
        <rect x="253" y="99" width="14" height="4.5" rx="2.25" fill="var(--th-on-16)" />

        {/* ── Decorative flecks ── */}
        <circle cx="10" cy="38" r="3.5" fill="var(--th-on-10)" />
        <circle cx="290" cy="40" r="2.5" fill="var(--th-on-12)" />
        <circle cx="288" cy="110" r="4" fill="var(--th-on-08)" />
        <circle cx="12" cy="116" r="3" fill="var(--th-on-06)" />
        <path d="M116 44 l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-16)" />
      </svg>
    </div>
  );
}

export default CloudIllustration;
