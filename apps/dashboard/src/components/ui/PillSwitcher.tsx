"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import { AppLogo } from "@/components/AppLogo";

/**
 * One reusable horizontal pill switcher — a single-select row of icon+label
 * pills. Used anywhere a set of choices needs a compact, branded switcher
 * (email provider presets, notification-channel kinds, …). When the options
 * overflow the width it stays on ONE line: each overflowing end gets a solid
 * surface-color → transparent gradient (so the pills fade cleanly into the
 * container behind the chevron, not into the page) with a left/right chevron to
 * scroll. Set `fadeColor` to match the surface (default = solid card bg). Each
 * option renders its real brand logo via `AppLogo` (`logo` = simpleicons slug,
 * `logoSrc` = explicit URL) and falls back to a lucide `icon`.
 *
 * The edge fade blends into `fadeColor` — a real CSS color, defaulting to the
 * theme's SOLID card background (`--th-card-bg-solid`). It must be a solid color:
 * a Tailwind `from-card` gradient is effectively invisible in the dark/dim themes
 * (where `card` isn't opaque), so the pills never appear to fade under the arrow.
 */

export interface PillOption<T extends string> {
  value: T;
  label: string;
  /** simpleicons slug for a real brand mark. */
  logo?: string;
  /** Explicit brand-logo URL — wins over `logo`. */
  logoSrc?: string;
  /** lucide glyph — the fallback when there's no brand mark. */
  icon?: LucideIcon;
}

export function PillSwitcher<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className = "",
  fadeColor = "var(--th-card-bg-solid, var(--card))",
}: {
  options: PillOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
  /** CSS color the edge fade blends INTO — match the surface behind the switcher.
   *  MUST be a solid color (default = the theme's solid card bg). Pass e.g.
   *  `var(--th-bg-solid, var(--background))` on a bare page. */
  fadeColor?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });

  const measure = () => {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdge((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.length]);

  // Keep the selected pill visible when the value changes from elsewhere.
  useEffect(() => {
    const el = scrollRef.current;
    el?.querySelector<HTMLElement>(`[data-pill="${value}"]`)?.scrollIntoView({
      inline: "nearest",
      block: "nearest",
    });
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const scrollByDir = (dir: -1 | 1) =>
    scrollRef.current?.scrollBy({ left: dir * 220, behavior: "smooth" });

  const pad = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-[13px]";
  const iconSize = size === "sm" ? "size-3.5" : "size-4";

  return (
    <div className={`relative ${className}`}>
      <div
        ref={scrollRef}
        onScroll={measure}
        className="flex gap-1.5 overflow-x-auto scroll-smooth [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {options.map((o) => {
          const on = o.value === value;
          const Icon = o.icon;
          return (
            <button
              key={o.value}
              type="button"
              data-pill={o.value}
              onClick={() => onChange(o.value)}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border font-medium transition-colors ${pad} ${
                on
                  ? "border-primary/40 bg-primary/[0.06] text-foreground"
                  : "border-border/60 text-muted-foreground hover:bg-muted/40"
              }`}
            >
              {o.logo || o.logoSrc ? (
                <AppLogo slug={o.logo} src={o.logoSrc} icon={Icon} className={iconSize} />
              ) : Icon ? (
                <Icon className={iconSize} />
              ) : null}
              {o.label}
            </button>
          );
        })}
      </div>

      {/* Left edge: solid surface-color fade (hides the pills scrolling under
          the chevron) + the scroll-left control on top. Inline gradient into the
          SOLID surface color so it stays visible in dark/dim (a `from-card`
          Tailwind gradient fades to a non-opaque color there → no visible fade). */}
      {edge.left && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 w-20"
            style={{ backgroundImage: `linear-gradient(to right, ${fadeColor}, transparent)` }}
          />
          <button
            type="button"
            onClick={() => scrollByDir(-1)}
            aria-label="Scroll left"
            style={{ backgroundColor: fadeColor }}
            className="absolute left-0 top-1/2 z-10 grid size-7 -translate-y-1/2 place-items-center rounded-full border border-border/60 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </button>
        </>
      )}

      {edge.right && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-20"
            style={{ backgroundImage: `linear-gradient(to left, ${fadeColor}, transparent)` }}
          />
          <button
            type="button"
            onClick={() => scrollByDir(1)}
            aria-label="Scroll right"
            style={{ backgroundColor: fadeColor }}
            className="absolute right-0 top-1/2 z-10 grid size-7 -translate-y-1/2 place-items-center rounded-full border border-border/60 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
        </>
      )}
    </div>
  );
}
