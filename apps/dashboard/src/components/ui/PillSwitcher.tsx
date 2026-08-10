"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import { AppLogo } from "@/components/AppLogo";

/**
 * One reusable horizontal pill switcher — a single-select row of icon+label
 * pills. Used anywhere a set of choices needs a compact, branded switcher
 * (email provider presets, notification-channel kinds, …). When the options
 * overflow the width it stays on ONE line with a left/right chevron to scroll.
 *
 * The overflowing edges fade out by MASKING the scroll row to transparent (not
 * by painting a color overlay) — so the pills dissolve into whatever surface is
 * actually behind them, matching the container background exactly in every theme
 * and at any nesting depth. A painted fill can't do this: `bg-card` is a
 * translucent rgba over the page, so no single opaque color lines up with it.
 *
 * Each option renders its real brand logo via `AppLogo` (`logo` = simpleicons
 * slug, `logoSrc` = explicit URL) and falls back to a lucide `icon`.
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
}: {
  options: PillOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
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

  // Fade the pills into whatever is actually behind them by masking the scroll
  // container to transparent at each scrollable edge — no color fill, so it
  // matches the container background exactly in every theme and nesting (a solid
  // color overlay never lines up with a translucent `bg-card` surface). Only the
  // scrollable edges get the fade; a non-scrollable edge stays crisp.
  const FADE = "2.25rem";
  const maskImage =
    edge.left && edge.right
      ? `linear-gradient(to right, transparent, #000 ${FADE}, #000 calc(100% - ${FADE}), transparent)`
      : edge.left
        ? `linear-gradient(to right, transparent, #000 ${FADE})`
        : edge.right
          ? `linear-gradient(to right, #000 calc(100% - ${FADE}), transparent)`
          : undefined;

  return (
    <div className={`relative ${className}`}>
      <div
        ref={scrollRef}
        onScroll={measure}
        style={maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined}
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

      {/* Scroll controls float over the masked (faded) edge — a frosted circle
          that blends with the surface via backdrop-blur, no fixed fill color. */}
      {edge.left && (
        <button
          type="button"
          onClick={() => scrollByDir(-1)}
          aria-label="Scroll left"
          className="absolute left-0 top-1/2 z-10 grid size-7 -translate-y-1/2 place-items-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm backdrop-blur-md transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
        </button>
      )}

      {edge.right && (
        <button
          type="button"
          onClick={() => scrollByDir(1)}
          aria-label="Scroll right"
          className="absolute right-0 top-1/2 z-10 grid size-7 -translate-y-1/2 place-items-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm backdrop-blur-md transition-colors hover:text-foreground"
        >
          <ChevronRight className="size-4" />
        </button>
      )}
    </div>
  );
}
