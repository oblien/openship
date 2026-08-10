"use client";

import type { ComponentType, ReactNode } from "react";

/**
 * The shell both home attention surfaces share: a card with a header strip (icon
 * tile + title + count + one line of context), a neutral body, and an optional
 * footer.
 *
 * Severity lives in the icon tile and the title, NOT in the card's edge. A tinted
 * border makes the whole card a status object, so a column holding two of them
 * reads as a wall of colored boxes and the tint stops meaning anything — and it
 * puts the loudest element on the least informative pixel. The border stays the
 * same neutral hairline every other card on the page uses; the eye is led by the
 * colored tile, title, and (for outages only) the solid action button.
 */
/**
 * `neutral` exists for advisories that sit BESIDE louder panels — on the `/issues`
 * feed an advisory group can render directly under an outage, and tinting it amber
 * there costs the glance-level difference between "down" and "a new version exists".
 * It uses the muted surface rather than a status color, so "advisory" reads as
 * information. Standing alone (the home Updates card) an advisory panel is amber:
 * nothing outranks it, so there is no tier to blur into.
 */
export type AlertTone = "danger" | "warning" | "neutral";

const TONE: Record<AlertTone, { tile: string; icon: string; title: string }> = {
  danger: {
    tile: "bg-danger-bg",
    icon: "text-danger",
    title: "text-danger",
  },
  warning: {
    tile: "bg-warning-bg",
    icon: "text-warning",
    title: "text-warning",
  },
  neutral: {
    tile: "bg-muted",
    icon: "text-muted-foreground",
    title: "text-foreground",
  },
};

/** For copy that has to carry the tone itself, e.g. a row's state line. */
export const TEXT_TONE: Record<AlertTone, string> = {
  danger: "text-danger",
  warning: "text-warning",
  neutral: "text-muted-foreground",
};

/** Row geometry is shared so a solid and a ghost action still line up. */
const ACTION_BASE =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors disabled:opacity-60";

export const ACTION_TONE: Record<AlertTone | "ghost", string> = {
  danger: `${ACTION_BASE} bg-danger-solid text-white hover:bg-danger-solid/90`,
  warning: `${ACTION_BASE} bg-warning-solid text-white hover:bg-warning-solid/90`,
  // An advisory's action is the ghost control by design — a solid button on
  // "an update is available" competes with the one on "your site is down".
  neutral: `${ACTION_BASE} border border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground`,
  ghost: `${ACTION_BASE} border border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground`,
};

interface AlertPanelProps {
  tone: AlertTone;
  icon: ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  count: number;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Top-right corner of the header strip — the home cards' hide button. A slot rather
   * than a `dismissible` flag because this component stays free of both the storage
   * rule and the translated label; the `/issues` groups pass nothing, since the
   * tracker's job is to list everything.
   */
  headerAction?: ReactNode;
}

export default function AlertPanel({
  tone,
  icon: Icon,
  title,
  subtitle,
  count,
  children,
  footer,
  headerAction,
}: AlertPanelProps) {
  const s = TONE[tone];
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className="flex items-start gap-3 border-b border-border/50 px-5 py-4">
        <div className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${s.tile}`}>
          <Icon className={`size-4 ${s.icon}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className={`truncate text-[14px] font-semibold ${s.title}`}>{title}</h3>
            <span className="ms-auto shrink-0 rounded-full bg-muted px-1.5 py-px text-[11px] font-medium tabular-nums text-muted-foreground">
              {count}
            </span>
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{subtitle}</p>
        </div>
        {headerAction && <div className="-me-2 -mt-1 shrink-0">{headerAction}</div>}
      </div>
      <div className="px-5 py-3.5">{children}</div>
      {footer && <div className="border-t border-border/50 px-5 py-2.5">{footer}</div>}
    </div>
  );
}

/**
 * One list entry in either card: a tinted component tile, a title line carrying
 * an optional secondary label and the action, then any detail lines.
 *
 * The detail block deliberately sits OUTSIDE the title flex row, indented to the
 * title's start edge. Keeping it inside meant sharing the row with a shrink-0
 * button, which in a ~320px sidebar column left the diagnosis about 150px — one
 * truncated fragment of the sentence that says what actually broke.
 */
export function AlertRow({
  tone,
  icon: Icon,
  title,
  label,
  children,
  action,
}: {
  tone: AlertTone;
  icon: ComponentType<{ className?: string }>;
  /** ReactNode so a row can link its own title (the Issues feed does); plain
   *  strings still work and are what the home cards pass. */
  title: ReactNode;
  label?: string;
  children?: ReactNode;
  action: ReactNode;
}) {
  const s = TONE[tone];
  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2.5">
        <div className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${s.tile}`}>
          <Icon className={`size-3.5 ${s.icon}`} />
        </div>
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <p className="truncate text-[13px] font-medium text-foreground">{title}</p>
          {label && (
            <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
          )}
        </div>
        {action}
      </div>
      {children && <div className="mt-1 ps-[2.375rem]">{children}</div>}
    </li>
  );
}
