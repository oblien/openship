"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/**
 * Full-width dark container with scroll-linked scale animation.
 * Faithful GSAP port of the dashboard's framer-motion DarkSection.
 *
 * Behavior (desktop only — mobile is flat, no animation):
 *  - Enter: scale 0.88→1, opacity 0.7→1, y 50→0
 *    Scale uses [0, 0.7] mapping — finishes early = fast zoom at end
 *    Opacity uses [0, 0.3] mapping — fades in quickly at start
 *  - Exit: scale 1→0.88, opacity 1→0.7
 *    Scale over full range, opacity in last 30%
 *  - Math.min(enter, exit) combines both — identical to framer MotionValue
 *  - marginBottom compensates for scale shrinkage (via ResizeObserver)
 *
 * Performance:
 *  - Zero React re-renders — all values are DOM mutations in onUpdate
 *  - Single apply() function for all properties — no tween fighting
 *  - willChange conditional (auto on mobile, transform/opacity on desktop)
 *  - ResizeObserver tracks height via ref, not state
 */
export function DarkSection({
  children,
}: {
  children: React.ReactNode;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef(0);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    /* ── Track height for margin compensation (no re-renders) ── */
    const ro = new ResizeObserver(([e]) => {
      heightRef.current = e.contentRect.height;
    });
    ro.observe(inner);

    /* ── Mobile: skip scale animation entirely ── */
    const mq = window.matchMedia("(max-width: 768px)");
    if (mq.matches) {
      inner.style.borderRadius = "0";
      outer.style.willChange = "auto";
      inner.style.willChange = "auto";
      ro.disconnect();
      return;
    }

    /* ── Desktop: set initial state (prevents flash) ── */
    inner.style.transform = "scale(0.88)";
    inner.style.transformOrigin = "top center";
    outer.style.opacity = "0.7";
    outer.style.marginTop = "-1rem";
    outer.style.willChange = "transform, opacity";
    inner.style.willChange = "transform";

    /* ── Mutable animation values (closure, no state) ── */
    let scaleIn = 0.88;
    let scaleOut = 1;
    let opacityIn = 0.7;
    let opacityOut = 1;
    let yIn = 50;

    /** Single apply function — mirrors framer's combined MotionValues.
     *  Math.min picks the smaller of enter/exit at any scroll position. */
    const apply = () => {
      const s = Math.min(scaleIn, scaleOut);
      const o = Math.min(opacityIn, opacityOut);
      inner.style.transform = `scale(${s})`;
      outer.style.opacity = String(o);
      outer.style.transform = `translateY(${yIn}px)`;
      outer.style.marginBottom = `${-(heightRef.current * (1 - s))}px`;
    };

    let ctx: gsap.Context | undefined;

    try {
      ctx = gsap.context(() => {
        /* ── Enter phase: element top from viewport bottom → top ── */
        ScrollTrigger.create({
          trigger: outer,
          start: "top bottom",
          end: "top top",
          onUpdate: (self) => {
            const p = self.progress; // 0 → 1

            // Scale: [0, 0.7] → [0.88, 1]  (fast — finishes at 70%)
            scaleIn = p < 0.7 ? 0.88 + (p / 0.7) * 0.12 : 1;

            // Opacity: [0, 0.3] → [0.7, 1]  (fast — finishes at 30%)
            opacityIn = p < 0.3 ? 0.7 + (p / 0.3) * 0.3 : 1;

            // Y: [0, 1] → [50, 0]  (full range parallax)
            yIn = 50 * (1 - p);

            apply();
          },
        });

        /* ── Exit phase: element bottom from viewport bottom → top ── */
        ScrollTrigger.create({
          trigger: outer,
          start: "bottom bottom",
          end: "bottom top",
          onUpdate: (self) => {
            const p = self.progress; // 0 → 1

            // Scale: [0, 1] → [1, 0.88]  (full range)
            scaleOut = 1 - p * 0.12;

            // Opacity: [0.7, 1] → [1, 0.7]  (last 30% only)
            opacityOut = p < 0.7 ? 1 : 1 - ((p - 0.7) / 0.3) * 0.3;

            apply();
          },
        });
      }, outer);

      ScrollTrigger.refresh();
    } catch {
      /* Fallback: show at full scale */
      inner.style.transform = "scale(1)";
      outer.style.opacity = "1";
      outer.style.transform = "translateY(0)";
      outer.style.marginBottom = "0";
    }

    return () => {
      ro.disconnect();
      ctx?.revert();
      outer.style.marginBottom = "0";
      outer.style.transform = "";
      outer.style.opacity = "";
      outer.style.willChange = "";
      inner.style.transform = "";
      inner.style.willChange = "";
    };
  }, []);

  return (
    <div
      ref={outerRef}
      className="dark-section"
    >
      <div
        ref={innerRef}
        className="dark-section__inner"
        data-section="dark"
      >
        {/* Top edge glow line */}
        <div className="dark-section__edge-glow" aria-hidden="true" />

        {children}
      </div>
    </div>
  );
}
