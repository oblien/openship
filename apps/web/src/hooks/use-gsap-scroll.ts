"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/**
 * Scroll-linked GSAP animations with `scrub` for the features section.
 *
 * Progressive-enhancement pattern:
 *  1. CSS: all elements visible by default (no opacity:0 in stylesheets).
 *  2. JS adds `.feat-animated` class → CSS hides the targets (opacity:0).
 *  3. `gsap.set()` applies initial transforms (y/x/scale).
 *  4. `gsap.to()` + ScrollTrigger scrub reveals them on scroll.
 *  5. If GSAP errors or the component unmounts, cleanup removes the class
 *     and reverts inline styles → elements are immediately visible again.
 */
export function useGsapScroll() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    /* Mark container so CSS can manage the "from" opacity */
    el.classList.add("feat-animated");

    let ctx: gsap.Context | undefined;

    try {
      ctx = gsap.context(() => {
        /* ── Section header ─────────────────────────────── */
        const header = el.querySelector<HTMLElement>(".feat-header");
        if (header) {
          gsap.set(header, { y: 60 });
          gsap.to(header, {
            y: 0,
            opacity: 1,
            ease: "none",
            scrollTrigger: {
              trigger: header,
              start: "top 92%",
              end: "top 60%",
              scrub: 0.6,
            },
          });
        }

        /* ── Each feature card ──────────────────────────── */
        const cards = el.querySelectorAll<HTMLElement>(".feat-card");

        cards.forEach((card) => {
          const text = card.querySelector<HTMLElement>(".feat-card-text");
          const visual = card.querySelector<HTMLElement>(".feat-card-visual");
          const buildItems = card.querySelectorAll<HTMLElement>(".feat-build-item");
          const bullets = card.querySelectorAll<HTMLElement>(".feat-bullets li");
          const inner = card.querySelector<HTMLElement>(".feat-card-inner");
          const isReversed = inner?.classList.contains("feat-card-inner--reverse");

          /* Card fade */
          gsap.to(card, {
            opacity: 1,
            ease: "none",
            scrollTrigger: {
              trigger: card,
              start: "top 90%",
              end: "top 68%",
              scrub: 0.6,
            },
          });

          /* Text slides up */
          if (text) {
            gsap.set(text, { y: 44 });
            gsap.to(text, {
              y: 0,
              opacity: 1,
              ease: "none",
              scrollTrigger: {
                trigger: card,
                start: "top 86%",
                end: "top 56%",
                scrub: 0.8,
              },
            });
          }

          /* Visual slides in from x-axis */
          if (visual) {
            const xFrom = isReversed ? -100 : 100;
            gsap.set(visual, { x: xFrom });
            gsap.to(visual, {
              x: 0,
              opacity: 1,
              ease: "none",
              scrollTrigger: {
                trigger: card,
                start: "top 88%",
                end: "top 48%",
                scrub: 1,
              },
            });
          }

          /* Build items — stagger in one-by-one */
          if (buildItems.length) {
            gsap.set(buildItems, { y: 20, scale: 0.97 });
            gsap.to(buildItems, {
              y: 0,
              opacity: 1,
              scale: 1,
              stagger: 0.06,
              ease: "none",
              scrollTrigger: {
                trigger: visual || card,
                start: "top 72%",
                end: "top 30%",
                scrub: 0.9,
              },
            });
          }

          /* Bullet points */
          if (bullets.length) {
            gsap.set(bullets, { y: 18 });
            gsap.to(bullets, {
              y: 0,
              opacity: 1,
              stagger: 0.05,
              ease: "none",
              scrollTrigger: {
                trigger: text || card,
                start: "top 58%",
                end: "top 32%",
                scrub: 0.8,
              },
            });
          }
        });
      }, el);

      /* Force recalculate — handles pages loaded mid-scroll */
      ScrollTrigger.refresh();
    } catch {
      /* GSAP failed → remove class so CSS shows everything */
      el.classList.remove("feat-animated");
    }

    return () => {
      el.classList.remove("feat-animated");
      ctx?.revert();
    };
  }, []);

  return containerRef;
}
