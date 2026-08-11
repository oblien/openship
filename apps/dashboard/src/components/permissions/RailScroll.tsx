"use client";

/**
 * The right rail's scroll region, so Deny/Authorize can be pinned OUTSIDE it.
 *
 * Why this exists: the rail is `lg:sticky`, which does nothing once the rail is
 * taller than the viewport — and a scope with several granted resources plus the
 * capability digest gets there on a 768px-tall laptop, leaving Authorize below the
 * fold on the one screen whose whole purpose is that button. Capping the rail to
 * the viewport and scrolling only its content keeps the decision always visible.
 *
 * Below `lg` this is inert (no cap, no scroll): the page scrolls normally there
 * and the actions live in a fixed bottom bar instead.
 *
 * The fade is measured rather than always-on because `::-webkit-scrollbar {
 * display: none }` is global — without it there is no cue whatsoever that content
 * continues below.
 */

import { useEffect, useRef, useState } from "react";

export function RailScroll({ children }: { children: React.ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  // Observe the CONTENT wrapper, not the box: the box's height is capped, so it
  // never resizes as rows are added and observing it alone would never fire.
  // Empty deps — one observer for the component's life, not one per render.
  useEffect(() => {
    const box = boxRef.current;
    const content = contentRef.current;
    if (!box || !content) return;
    const measure = () => setOverflowing(content.scrollHeight > box.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(content);
    ro.observe(box); // catches the viewport-relative cap changing on resize
    return () => ro.disconnect();
  }, []);

  return (
    <div className="relative min-h-0 lg:flex-1">
      <div ref={boxRef} className="lg:h-full lg:overflow-y-auto">
        <div ref={contentRef} className="space-y-4">
          {children}
        </div>
      </div>
      {overflowing && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-10 bg-gradient-to-t from-background to-transparent lg:block"
        />
      )}
    </div>
  );
}
