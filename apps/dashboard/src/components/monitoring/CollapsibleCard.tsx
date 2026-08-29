"use client";

/**
 * A card that folds away, remembering whether it was open.
 *
 * Built for the traffic block, which duplicates a chart the Overview tab already draws —
 * worth keeping (it has tooltips and follows the domain scope, which Overview's sparkline
 * does not) but not worth ~300px between the map and the lists below it by default.
 *
 * Two details that make a fold worth using rather than annoying:
 *
 *  • The header carries the SUMMARY. A collapsed section showing only its own title is a
 *    row of furniture; one showing "Traffic overview — 99.4K requests" still answers the
 *    question most visits are asking, and only the shape of the curve needs the click.
 *  • The state is REMEMBERED, and read lazily on the client so the first paint is already
 *    correct. A `useEffect` would render the default and then snap, which on a block this
 *    tall is a visible jump on every navigation.
 *
 * Children are not rendered while closed, so a collapsed chart costs no recharts mount and
 * no measurement — the point is to make the tab cheaper, not just shorter.
 */

import React, { useState } from "react";
import { ChevronRight } from "lucide-react";

interface Props {
  title: string;
  /** Rendered on the fold line, right-aligned. */
  summary?: string;
  /** localStorage key for the open/closed choice. */
  storageKey: string;
  /** Open on the very first visit, before any choice has been stored. */
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function initialOpen(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    // Private mode / storage disabled — the fold still works for this session.
    return fallback;
  }
}

export const CollapsibleCard: React.FC<Props> = ({
  title,
  summary,
  storageKey,
  defaultOpen = false,
  children,
}) => {
  const [open, setOpen] = useState(() => initialOpen(storageKey, defaultOpen));

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      window.localStorage.setItem(storageKey, next ? "1" : "0");
    } catch {
      /* nothing to do; the choice applies for this session */
    }
  };

  return (
    <div className="rounded-2xl bg-card">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-5 py-3.5 text-left"
      >
        <ChevronRight
          aria-hidden
          className={`size-4 shrink-0 text-muted-foreground transition-transform duration-150 ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="min-w-0 flex-1" />
        {summary && (
          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{summary}</span>
        )}
      </button>
      {/* No padding wrapper: the child is already a card-shaped block with its own padding,
          and nesting two paddings made the chart sit in a visible inset. */}
      {open && <div className="-mt-1">{children}</div>}
    </div>
  );
};
