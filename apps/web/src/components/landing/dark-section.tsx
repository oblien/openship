"use client";
import { reportCaughtError } from "@repo/core/diagnostics";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/** Animate the inner surface against a stable wrapper. Entry finishes before
 * exit begins, including for sections shorter than the viewport. */
export function DarkSection({ children }: { children: React.ReactNode }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const clearAnimation = () => {
      inner.style.transform = "";
      inner.style.opacity = "";
      inner.style.willChange = "";
    };
    const media = gsap.matchMedia();

    try {
      media.add("(min-width: 769px) and (prefers-reduced-motion: no-preference)", () => {
        let enterProgress = 0;
        let exitProgress = 0;
        const apply = () => {
          const progress = Math.min(enterProgress, 1 - exitProgress);
          inner.style.transform = `translateY(${50 * (1 - enterProgress)}px) scale(${0.88 + progress * 0.12})`;
          inner.style.opacity = String(0.7 + Math.min(progress * 2, 1) * 0.3);
        };
        const updateEnter = (trigger: ScrollTrigger) => {
          enterProgress = trigger.progress;
          apply();
        };
        const updateExit = (trigger: ScrollTrigger) => {
          exitProgress = trigger.progress;
          apply();
        };

        inner.style.willChange = "transform, opacity";
        ScrollTrigger.create({
          trigger: outer,
          start: "top bottom",
          end: "top 65%",
          onUpdate: updateEnter,
          onRefresh: updateEnter,
        });
        ScrollTrigger.create({
          trigger: outer,
          start: "bottom 35%",
          end: "bottom top",
          onUpdate: updateExit,
          onRefresh: updateExit,
        });
        apply();

        // Fonts, images and upstream sections can move this trigger after mount.
        // Safe refresh coalesces notifications; transforms never alter layout.
        const observer = new ResizeObserver(() => ScrollTrigger.refresh(true));
        observer.observe(outer);
        observer.observe(document.body);

        return () => {
          observer.disconnect();
          clearAnimation();
        };
      });
    } catch (error) {
      reportCaughtError(error, "web/components/landing/dark-section");
      media.revert();
      clearAnimation();
    }

    return () => media.revert();
  }, []);

  return (
    <div ref={outerRef} className="dark-section">
      <div ref={innerRef} className="dark-section__inner" data-section="dark">
        {/* Top edge glow line */}
        <div className="dark-section__edge-glow" aria-hidden="true" />

        {children}
      </div>
    </div>
  );
}
