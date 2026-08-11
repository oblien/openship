/**
 * The empty vessel IS the panel an issue arrives in.
 *
 * Every measurement is taken from the real thing: `AlertPanel`'s shell, its size-9
 * scope tile, its `ms-auto` count chip, its `divide-y divide-border/50` row rule, and
 * `IssueRow`'s h-7 action pill. When a real row appears it lands in a silhouette the
 * operator has already learned — which is the promise ("anything wrong shows up here"),
 * made structurally instead of with a tick mark. A tick would be a verdict, and this
 * page never decides that something is fine.
 *
 * Surfaces are `--th-sf-05` / `--th-sf-08`, NOT `--th-card-bg`: this mounts inside a
 * `bg-card` box, where card-bg is translucent (rgba(255,255,255,.05) dark, .03 dim) and
 * would composite to nothing.
 *
 * The one accent is `var(--primary)`, which resolves to `--th-btn-bg` — achromatic in
 * every theme, so it cannot read as a status hue, while landing brighter than
 * `--th-on-20` (the family's brightest stroke). Spent on exactly one thing, in the
 * `open` variant only: the place a row lands. No status token and no hex anywhere, so
 * an empty feed stays a neutral surface rather than a green all-clear.
 *
 * viewBox is cropped to real content bounds rather than the house 0 0 260 180, so no
 * dead band sits between the art and the heading. Static, like all 15 sibling
 * illustrations — nothing for prefers-reduced-motion to respect.
 */
export function IssuesIllustration({
  variant,
  className,
}: {
  variant: "open" | "resolved" | "filtered";
  className?: string;
}) {
  return (
    <div className={className ?? "relative mx-auto mb-6 h-36 w-64 max-w-full"}>
      {/* Mirrored in RTL, unlike the rest of the family — deliberately. The scene has
          no text, and it impersonates a panel whose count chip is `ms-auto`, so the
          real IssueGroups beside it do flip in Arabic. */}
      <svg
        className="absolute inset-0 h-full w-full rtl:-scale-x-100"
        viewBox="6 18 248 140"
        fill="none"
        aria-hidden="true"
      >
        {/* Three-layer card stack, back to front, uniform 8px diagonal step. The
            backmost carries no stroke: the depth cue is fill-darkness and
            stroke-presence together. */}
        <rect x="46" y="40" width="170" height="112" rx="14" fill="var(--th-sf-04)" />
        <rect
          x="38"
          y="32"
          width="170"
          height="112"
          rx="14"
          fill="var(--th-sf-03)"
          stroke="var(--th-bd-subtle)"
          strokeWidth="1"
        />
        <rect
          x="30"
          y="24"
          width="170"
          height="112"
          rx="14"
          fill="var(--th-sf-05)"
          stroke="var(--th-bd-default)"
          strokeWidth="1"
        />

        {/* Panel header — a top-rounded path, so the bottom corners are genuinely
            square. It closes on the front card's own rx=14 (30+14, 200-14). No window
            chrome: the real panel has none, it has a scope tile, title, subtitle and a
            count. */}
        <path d="M30 38a14 14 0 0 1 14-14h142a14 14 0 0 1 14 14v20H30z" fill="var(--th-sf-08)" />
        <rect x="40" y="33" width="16" height="16" rx="5" fill="var(--th-on-08)" />
        <rect x="62" y="35" width="54" height="6" rx="3" fill="var(--th-on-12)" />
        <rect x="62" y="45" width="76" height="4" rx="2" fill="var(--th-on-06)" />
        <rect x="170" y="36" width="20" height="11" rx="5.5" fill="var(--th-on-08)" />
        <path d="M30 58h170" stroke="var(--th-bd-subtle)" strokeWidth="1" />

        {/* The panel's row rule. Dropped in the filtered scene, where the lens
            delimits the band instead. */}
        {variant !== "filtered" && (
          <path d="M40 84h150M40 108h150" stroke="var(--th-bd-subtle)" strokeWidth="1" />
        )}

        {variant === "open" && (
          <>
            {/* The reserved slot — the house plate/dashed-ring CTA pair restated as a
                ROW. The house ring holds a plus because it invites you to act; this one
                holds nothing, because there is nothing to report and the emptiness is
                the content. The only dashed and only accented thing in the scene, so
                the focal point is the place an issue will appear. */}
            <rect
              x="36"
              y="62"
              width="158"
              height="20"
              rx="10"
              fill="var(--primary)"
              fillOpacity="0.05"
            />
            <rect
              x="40"
              y="65"
              width="14"
              height="14"
              rx="4"
              fill="var(--th-on-05)"
              stroke="var(--primary)"
              strokeOpacity="0.3"
              strokeWidth="1.5"
              strokeDasharray="4 3"
            />
            <rect
              x="60"
              y="66"
              width="62"
              height="12"
              rx="6"
              stroke="var(--primary)"
              strokeOpacity="0.3"
              strokeWidth="1.5"
              strokeDasharray="4 3"
            />
            <rect
              x="156"
              y="66"
              width="34"
              height="12"
              rx="6"
              stroke="var(--th-on-12)"
              strokeWidth="1"
            />

            {/* Rows 2-3: the same row anatomy, dissolving downward — a list with room,
                not a shape someone forgot to fill. */}
            <rect x="40" y="89" width="14" height="14" rx="4" fill="var(--th-on-08)" />
            <rect x="60" y="93" width="44" height="6" rx="3" fill="var(--th-on-08)" />
            <rect x="156" y="90" width="34" height="12" rx="6" fill="var(--th-on-05)" />
            <rect x="40" y="113" width="14" height="14" rx="4" fill="var(--th-on-05)" />
            <rect x="60" y="117" width="32" height="6" rx="3" fill="var(--th-on-08)" />
          </>
        )}

        {variant === "resolved" && (
          <>
            {/* A history rail, not arrival slots: nothing is about to land in the past.
                The spine's tail goes dashed and stops short of the card edge, where the
                30-day window ends. No accent at all here — an emphasised "next slot" on
                a history tab would imply recoveries are expected. */}
            <rect x="60" y="69" width="58" height="6" rx="3" fill="var(--th-on-12)" />
            <rect x="156" y="66" width="34" height="12" rx="6" fill="var(--th-on-05)" />
            <rect x="60" y="93" width="44" height="6" rx="3" fill="var(--th-on-08)" />
            <rect x="156" y="90" width="34" height="12" rx="6" fill="var(--th-on-05)" />
            <rect x="60" y="117" width="32" height="6" rx="3" fill="var(--th-on-08)" />
            <path
              d="M47 77V91M47 101V115"
              stroke="var(--th-on-16)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path
              d="M47 125V132"
              stroke="var(--th-on-12)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeDasharray="3 3"
            />
            {/* Nodes last: their fill occludes the spine ends cleanly. */}
            <circle
              cx="47"
              cy="72"
              r="5"
              fill="var(--th-sf-05)"
              stroke="var(--th-on-20)"
              strokeWidth="1.5"
            />
            <circle
              cx="47"
              cy="96"
              r="5"
              fill="var(--th-sf-05)"
              stroke="var(--th-on-20)"
              strokeWidth="1.5"
            />
            <circle
              cx="47"
              cy="120"
              r="5"
              fill="var(--th-sf-05)"
              stroke="var(--th-on-20)"
              strokeWidth="1.5"
            />
          </>
        )}

        {variant === "filtered" && (
          <>
            {/* The one nothing where something IS wrong, so it is inverted: two rows
                are drawn POPULATED, and the dashed lens over the band between them
                holds nothing. Rows exist; the frame you typed excludes them. The lens
                is neutral — it is an obstruction, not an invitation. */}
            <rect x="40" y="65" width="14" height="14" rx="4" fill="var(--th-on-16)" />
            <rect x="60" y="69" width="58" height="6" rx="3" fill="var(--th-on-12)" />
            <rect x="156" y="66" width="34" height="12" rx="6" fill="var(--th-on-10)" />
            <rect x="40" y="113" width="14" height="14" rx="4" fill="var(--th-on-16)" />
            <rect x="60" y="117" width="44" height="6" rx="3" fill="var(--th-on-12)" />
            <rect x="156" y="114" width="34" height="12" rx="6" fill="var(--th-on-10)" />
            {/* Drawn last so the dashed stroke reads as an overlay on the rows. */}
            <rect
              x="40"
              y="85"
              width="150"
              height="22"
              rx="6"
              fill="var(--th-sf-03)"
              stroke="var(--th-on-25)"
              strokeWidth="1.5"
              strokeDasharray="4 3"
            />
          </>
        )}

        {/* Edge kit — decorative dots in the margins (bigger = fainter, never above
            on-12) and the family's two 4-point sparkles. */}
        <circle cx="14" cy="52" r="4" fill="var(--th-on-10)" />
        <circle cx="20" cy="128" r="6" fill="var(--th-on-08)" />
        <circle cx="236" cy="40" r="3" fill="var(--th-on-12)" />
        <circle cx="244" cy="118" r="5" fill="var(--th-on-06)" />
        <path d="M14 96l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
        <path d="M230 140l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />
      </svg>
    </div>
  );
}

export default IssuesIllustration;
