"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Priority cards stay in normal flow; the optional tip uses only spare viewport space. */
export default function HomeSidebar({ children, tip }: { children: ReactNode; tip: ReactNode }) {
  const anchorRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipFits, setTipFits] = useState(false);
  const hasTip = Boolean(tip);

  useEffect(() => {
    const anchor = anchorRef.current;
    const content = contentRef.current;
    const tipElement = tipRef.current;
    if (!anchor || !content || !tipElement || !hasTip) return;

    const scrollport = anchor.closest("main");
    const page = anchor.parentElement?.parentElement;
    const measure = () => {
      const viewportBottom = Math.min(
        scrollport?.getBoundingClientRect().bottom ?? window.innerHeight,
        window.visualViewport
          ? window.visualViewport.offsetTop + window.visualViewport.height
          : window.innerHeight,
      );
      // Use the column's natural position, not its sticky/scrolled position:
      // scrolling must not toggle a tip and make the page height oscillate.
      const top = anchor.getBoundingClientRect().top + (scrollport?.scrollTop ?? window.scrollY);
      const padding = page ? parseFloat(getComputedStyle(page).paddingBottom) || 0 : 0;
      const tipHeight = tipElement.getBoundingClientRect().height;
      setTipFits(
        tipHeight > 0 &&
          top + content.getBoundingClientRect().height + tipHeight <= viewportBottom - padding,
      );
    };

    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const element of [content, tipElement, scrollport, page]) {
      if (element) observer?.observe(element);
    }
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [hasTip]);

  return (
    <aside ref={anchorRef} className="min-w-0">
      <div className="relative lg:sticky lg:top-6">
        <div ref={contentRef} className="space-y-4">
          {children}
        </div>
        {hasTip && (
          <div
            ref={tipRef}
            aria-hidden={!tipFits}
            inert={!tipFits}
            className={`pt-4 ${tipFits ? "" : "invisible absolute inset-x-0 top-0 pointer-events-none"}`}
          >
            {tip}
          </div>
        )}
      </div>
    </aside>
  );
}
