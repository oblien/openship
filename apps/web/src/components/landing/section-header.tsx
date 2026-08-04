"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Section header - the ruled grid's chapter marker.
 *
 * One per converted section, and always its first child: it is sticky, so
 * being scoped to the section is what makes it hand over to the next header
 * instead of piling up under the navbar.
 *
 * The counter is passed in rather than derived. The order of the sections is
 * a property of the page, not of any one section, so the page is the only
 * place that should have to know it.
 */
export function SectionHeader({
  label,
  index,
  total,
}: {
  label: string;
  index: number;
  total: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /* State rather than a data attribute written straight to the node: the
     observer only fires when the row crosses the threshold, so a re-render
     in between would reconcile a directly-written attribute back to its
     JSX value and the shadow would silently stop working. */
  const [pinned, setPinned] = useState(false);

  /* "Is this header pinned" is a threshold question, so it is an observer
     rather than a scroll handler: the row only stops being fully visible
     once it has come to rest against the navbar. */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const navH =
      parseInt(
        getComputedStyle(document.documentElement).getPropertyValue("--lp-nav-h"),
        10,
      ) || 76;

    const io = new IntersectionObserver(
      ([entry]) =>
        /* Clipped at the top edge, not merely off screen: a header still
           below the fold is also "not fully visible", and lifting it there
           would show the shadow before the row has parked anywhere. */
        setPinned(
          entry.intersectionRatio < 1 &&
            entry.boundingClientRect.top <= navH + 1,
        ),
      { rootMargin: `-${navH + 1}px 0px 0px 0px`, threshold: [1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className="lp-band lp-sechead" data-pinned={pinned}>
      <div className="lp-band-in lp-sechead-in">
        <span className="lp-sechead-label">
          <span className="lp-sechead-chevron" aria-hidden="true">
            &#12297;
          </span>
          {label}
        </span>
        <span className="lp-sechead-rule" aria-hidden="true" />
        <span className="lp-sechead-count">
          [<span className="lp-sechead-count-n">{index}</span>/{total}]
        </span>
      </div>
    </div>
  );
}
