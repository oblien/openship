"use client";

import { useEffect, useRef } from "react";
import { useGsapScroll } from "@/hooks/use-gsap-scroll";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { DarkSection } from "../dark-section";
import { CloudVisual } from "./cloud-visual";
import { AiVisual } from "./ai-visual";
import { GitVisual } from "./git-visual";
import { RollbackVisual } from "./rollback-visual";
import { StacksVisual } from "./stacks-visual";
import { SslVisual } from "./ssl-visual";
import { InfraVisual } from "./infra-visual";

gsap.registerPlugin(ScrollTrigger);

/* ─── Hook: scroll-drawn border ─────────────────────────────── */
/**
 * Two mirrored SVG paths that draw simultaneously on scroll:
 *
 *   Right half: center-top → top-right → bottom-right → center-bottom
 *   Left half:  center-top → top-left  → bottom-left  → center-bottom
 *
 * Animation phases (scroll → draw):
 *   1. Top edges expand from center outward to corners
 *   2. Both sides descend simultaneously
 *   3. Bottom edges close from corners toward center
 *
 * Sharp corners. Real pixel-based stroke-dasharray/dashoffset.
 */
function useDrawBorder() {
  const svgRef = useRef<SVGSVGElement>(null);
  const rightRef = useRef<SVGPathElement>(null);
  const leftRef = useRef<SVGPathElement>(null);
  const dividersRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const rPath = rightRef.current;
    const lPath = leftRef.current;
    const divG = dividersRef.current;
    if (!svg || !rPath || !lPath || !divG) return;

    const section = svg.closest(".feat-section") as HTMLElement;
    const container = section?.querySelector(".feat-container") as HTMLElement;
    const cardsGrid = section?.querySelector(".feat-cards-grid") as HTMLElement;
    if (!container || !section || !cardsGrid) return;

    /* ── tuneable consts ─────────────────────────────────── */
    const MAX_W        = 1280;   // max border width — matches navbar max-w-7xl
    const TK           = 20;     // + crosshair arm length (px)
    const STROKE_COLOR = "rgba(255,255,255,0.12)"; // border stroke color (light for dark bg)
    /* ──────────────────────────────────────────────────────── */

    const MARGIN = TK + 2; // viewBox bleed so outward ticks aren't clipped

    /** Measure the dynamic TOP_OFFSET = distance from section top to cards-grid top
     *  Uses offsetTop chain — immune to parent CSS transforms (DarkSection scale). */
    const measureOffset = () => {
      let top = 0;
      let el: HTMLElement | null = cardsGrid;
      while (el && el !== section) {
        top += el.offsetTop;
        el = el.offsetParent as HTMLElement | null;
      }
      return top;
    };

    const measure = () => {
      const topOffset = measureOffset();
      const sw = Math.min(window.innerWidth, MAX_W);
      const sh = cardsGrid.offsetHeight; // CSS pixels, not affected by parent transform
      return { sw, sh, topOffset };
    };

    const cross = (cx: number, cy: number, outX: number, inX: number, outY: number, inY: number) => [
      `L ${cx + outX},${cy}`,
      `L ${cx + inX},${cy}`,
      `L ${cx},${cy}`,
      `L ${cx},${cy + outY}`,
      `L ${cx},${cy + inY}`,
      `L ${cx},${cy}`,
    ];

    const buildRight = (sw: number, sh: number) => {
      const vw = sw + MARGIN * 2;
      const vh = sh + MARGIN * 2;
      const cx = vw / 2;
      const t = MARGIN + 0.5;
      const r = vw - MARGIN - 0.5;
      const b = vh - MARGIN - 0.5;
      return [
        `M ${cx},${t}`,
        `L ${r},${t}`,
        ...cross(r, t, TK, -TK, -TK, TK),
        `L ${r},${b}`,
        ...cross(r, b, TK, -TK, TK, -TK),
        `L ${cx},${b}`,
      ].join(' ');
    };

    const buildLeft = (sw: number, sh: number) => {
      const vw = sw + MARGIN * 2;
      const vh = sh + MARGIN * 2;
      const cx = vw / 2;
      const t = MARGIN + 0.5;
      const l = MARGIN + 0.5;
      const b = vh - MARGIN - 0.5;
      return [
        `M ${cx},${t}`,
        `L ${l},${t}`,
        ...cross(l, t, -TK, TK, -TK, TK),
        `L ${l},${b}`,
        ...cross(l, b, -TK, TK, TK, -TK),
        `L ${cx},${b}`,
      ].join(' ');
    };

    const calcLen = (sw: number, sh: number) => {
      return sw / 2 + (TK * 6) + sh + (TK * 6) + sw / 2;
    };

    /* ── Divider line elements (created once, updated on resize) ── */
    let dividerLines: { left: SVGLineElement; right: SVGLineElement; card: HTMLElement }[] = [];

    const cards = section.querySelectorAll<HTMLElement>(".feat-card");

    /** Create SVG line pairs for each card boundary (skip first — top edge of rect is the divider) */
    const createDividers = () => {
      while (divG.firstChild) divG.removeChild(divG.firstChild);
      dividerLines = [];

      cards.forEach((card, i) => {
        if (i === 0) return; // first card's top = border-rect top edge
        const makeL = () => {
          const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
          l.style.stroke = STROKE_COLOR;
          l.style.strokeWidth = "1";
          l.style.fill = "none";
          l.setAttribute("vector-effect", "non-scaling-stroke");
          return l;
        };
        const left = makeL();
        const right = makeL();
        divG.appendChild(left);
        divG.appendChild(right);
        dividerLines.push({ left, right, card });
      });
    };

    createDividers();

    /** Position dividers at each card boundary, extending past rect edges by TK for + crosshairs */
    const setupDividers = (sw: number) => {
      const vw = sw + MARGIN * 2;
      const cx = vw / 2;
      const l = MARGIN + 0.5;           // left edge of rect
      const r = vw - MARGIN - 0.5;      // right edge of rect
      const lTick = l - TK;             // extend past left edge for + mark
      const rTick = r + TK;             // extend past right edge for + mark
      const halfLen = (sw / 2) + TK;    // half-line length including tick
      const gridOffsetTop = cardsGrid.offsetTop; // grid's offset relative to its offsetParent

      dividerLines.forEach(({ left, right, card }) => {
        // Card's top relative to grid (CSS px, transform-safe)
        const cardTopInGrid = card.offsetTop - gridOffsetTop;
        const svgY = cardTopInGrid + MARGIN + 0.5;

        // Right half: center → right edge + TK overshoot
        right.setAttribute("x1", String(cx));
        right.setAttribute("y1", String(svgY));
        right.setAttribute("x2", String(rTick));
        right.setAttribute("y2", String(svgY));
        right.style.strokeDasharray = `${halfLen}`;
        right.style.strokeDashoffset = `${halfLen}`;

        // Left half: center → left edge + TK overshoot
        left.setAttribute("x1", String(cx));
        left.setAttribute("y1", String(svgY));
        left.setAttribute("x2", String(lTick));
        left.setAttribute("y2", String(svgY));
        left.style.strokeDasharray = `${halfLen}`;
        left.style.strokeDashoffset = `${halfLen}`;
      });
    };

    const setup = () => {
      const { sw, sh, topOffset } = measure();
      const vw = sw + MARGIN * 2;
      const vh = sh + MARGIN * 2;
      svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
      svg.style.width = `${vw}px`;
      svg.style.height = `${vh}px`;
      svg.style.top = `${topOffset - MARGIN}px`;
      rPath.setAttribute("d", buildRight(sw, sh));
      lPath.setAttribute("d", buildLeft(sw, sh));
      rPath.style.stroke = STROKE_COLOR;
      lPath.style.stroke = STROKE_COLOR;

      const len = calcLen(sw, sh);
      rPath.style.strokeDasharray = `${len}`;
      rPath.style.strokeDashoffset = `${len}`;
      lPath.style.strokeDasharray = `${len}`;
      lPath.style.strokeDashoffset = `${len}`;

      setupDividers(sw);

      return len;
    };

    let len = setup();

    const ro = new ResizeObserver(() => {
      len = setup();
      ScrollTrigger.refresh();
    });
    ro.observe(section);

    let ctx: gsap.Context | undefined;

    try {
      ctx = gsap.context(() => {
        // Border paths — draw on section scroll
        gsap.to([rPath, lPath], {
          strokeDashoffset: 0,
          ease: "none",
          scrollTrigger: {
            trigger: section,
            start: "top 80%",
            end: "bottom 60%",
            scrub: true,
          },
        });

        // Dividers — each draws from center outward as its card scrolls in
        dividerLines.forEach(({ left, right, card }) => {
          gsap.to([left, right], {
            strokeDashoffset: 0,
            ease: "none",
            scrollTrigger: {
              trigger: card,
              start: "top 85%",
              end: "top 50%",
              scrub: true,
            },
          });
        });
      }, section as Element);
    } catch {
      rPath.style.strokeDashoffset = "0";
      lPath.style.strokeDashoffset = "0";
      dividerLines.forEach(({ left, right }) => {
        left.style.strokeDashoffset = "0";
        right.style.strokeDashoffset = "0";
      });
    }

    return () => {
      ro.disconnect();
      ctx?.revert();
    };
  }, []);

  return { svgRef, rightRef, leftRef, dividersRef };
}

/* ─── Aurora palette per feature — mixed hues like hero (violet+amber+cyan etc) ─ */
const BLOB_PALETTE = [
  { // Cloud — violet core · amber wings · rose bleed
    lCore: "rgba(139,92,246,.38)", lUp: "rgba(245,158,11,.24)", lLo: "rgba(244,63,94,.18)",
    rCore: "rgba(251,191,36,.32)", rUp: "rgba(167,139,250,.22)", rLo: "rgba(253,224,71,.16)",
  },
  { // Infra — cyan core · violet wings · amber bleed
    lCore: "rgba(6,182,212,.36)", lUp: "rgba(139,92,246,.22)", lLo: "rgba(251,191,36,.16)",
    rCore: "rgba(139,92,246,.32)", rUp: "rgba(34,211,238,.22)", rLo: "rgba(245,158,11,.14)",
  },
  { // AI — violet core · cyan wings · rose bleed
    lCore: "rgba(139,92,246,.38)", lUp: "rgba(6,182,212,.22)", lLo: "rgba(251,113,133,.16)",
    rCore: "rgba(34,211,238,.30)", rUp: "rgba(192,132,252,.22)", rLo: "rgba(244,63,94,.14)",
  },
  { // Git — amber core · violet wings · emerald bleed
    lCore: "rgba(245,158,11,.36)", lUp: "rgba(139,92,246,.22)", lLo: "rgba(52,211,153,.16)",
    rCore: "rgba(167,139,250,.32)", rUp: "rgba(253,224,71,.22)", rLo: "rgba(16,185,129,.14)",
  },
  { // Rollback — emerald core · amber wings · violet bleed
    lCore: "rgba(16,185,129,.34)", lUp: "rgba(251,191,36,.22)", lLo: "rgba(139,92,246,.16)",
    rCore: "rgba(245,158,11,.30)", rUp: "rgba(52,211,153,.22)", rLo: "rgba(167,139,250,.14)",
  },
  { // Stacks — purple core · cyan wings · amber bleed
    lCore: "rgba(147,51,234,.34)", lUp: "rgba(34,211,238,.22)", lLo: "rgba(251,191,36,.16)",
    rCore: "rgba(6,182,212,.30)", rUp: "rgba(192,132,252,.22)", rLo: "rgba(245,158,11,.14)",
  },
  { // SSL — rose core · violet wings · amber bleed
    lCore: "rgba(244,63,94,.34)", lUp: "rgba(139,92,246,.22)", lLo: "rgba(253,224,71,.16)",
    rCore: "rgba(167,139,250,.30)", rUp: "rgba(251,113,133,.22)", rLo: "rgba(245,158,11,.14)",
  },
];

/* ─── Hook: scroll-linked edge aurora (0 re-renders, DOM-only) ── */
function useEdgeBlobs(enabled: boolean) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) return;
    let ctx: any;

    gsap.registerPlugin(ScrollTrigger);

    const left = leftRef.current;
    const right = rightRef.current;
    if (!left || !right) return;

    const section = left.parentElement?.querySelector(".feat-section");
    if (!section) return;

    const cards = section.querySelectorAll<HTMLElement>(".feat-card");
    if (!cards.length) return;

      /* Helper: set all 6 CSS vars on both elements instantly */
      const applyPalette = (i: number) => {
        const p = BLOB_PALETTE[i] ?? BLOB_PALETTE[0];
        const targets = [left, right];
        for (const el of targets) {
          el.style.setProperty("--lc", p.lCore);
          el.style.setProperty("--lu", p.lUp);
          el.style.setProperty("--ll", p.lLo);
          el.style.setProperty("--rc", p.rCore);
          el.style.setProperty("--ru", p.rUp);
          el.style.setProperty("--rl", p.rLo);
        }
      };

      ctx = gsap.context(() => {
        /* Fade in/out with scrub — no callbacks */
        gsap.fromTo(
          [left, right],
          { opacity: 0 },
          {
            opacity: 1,
            ease: "none",
            scrollTrigger: {
              trigger: section,
              start: "top 80%",
              end: "top 40%",
              scrub: true,
            },
          }
        );
        gsap.fromTo(
          [left, right],
          { opacity: 1 },
          {
            opacity: 0,
            ease: "none",
            immediateRender: false,
            scrollTrigger: {
              trigger: section,
              start: "bottom 60%",
              end: "bottom 20%",
              scrub: true,
            },
          }
        );

        /* Color swap per card — direct DOM style, no tween */
        cards.forEach((card, i) => {
          ScrollTrigger.create({
            trigger: card,
            start: "top 65%",
            onEnter: () => applyPalette(i),
            onEnterBack: () => applyPalette(i),
          });
        });
      }, section);

    return () => { ctx?.revert(); };
  }, [enabled]);

  return { leftRef, rightRef };
}

/* ─── Feature data ──────────────────────────────────────────── */
const FEATURES: {
  title: string;
  description: string;
  points: string[];
  Visual: React.ComponentType;
  accent: "violet" | "amber";
  bg: string;
  color: string;
  overlay: string;
  backdropFilter?: string;
}[] = [
    {
      title: "Deploy Anywhere",
      description:
        "Use Openship Cloud and deploy instantly, or connect your own servers — any VPS, any provider, any region. Add more servers as you grow. Same app, your rules.",
      points: [
        "Openship Cloud with automatic scaling — zero config",
        "Connect any Linux server — any provider, any region",
        "Multi-server deployments — not limited to one box",
      ],
      Visual: CloudVisual,
      accent: "violet",
      bg: "https://framerusercontent.com/images/DWC8UZeRiKEKDpUceDrVk7IfyA.jpg",
      color: "rgba(255,255,255,1)",
      overlay: "rgba(0,0,0,0.82)",
    },
    {
      title: "Full Backend Stack",
      description:
        "Openship sets up your entire backend — API, database, Redis, WebSocket, workers. It detects what you need, the dashboard lets you tweak it. No Docker knowledge required.",
      points: [
        "Auto-provisions Postgres, Redis, MongoDB",
        "Built-in API gateway, WebSocket & worker support",
        "Private networking between services — configured automatically",
      ],
      Visual: InfraVisual,
      accent: "amber",
      bg: "https://framerusercontent.com/images/RPfj9rnNJTScxvWiCwQ189Xde0.jpg",
      color: "rgba(255,255,255,1)",
      overlay: "rgba(0,0,0,0.82)",
    },
    {
      title: "Smart Builds",
      description:
        "Every build runs locally on your machine. Errors are detected, diagnosed, and fixed automatically before anything touches your server.",
      points: [
        "Automatic error detection and root-cause analysis",
        "Fixes applied automatically — broken builds never reach your server",
        "Learns your project patterns over time",
      ],
      Visual: AiVisual,
      accent: "violet",
      bg: "https://framerusercontent.com/images/H1DkziaAiY3dL9msAC3bwGQqJY.jpg",
      color: "rgba(255,255,255,1)",
      overlay: "rgba(0,0,0,0.82)",
    },
    {
      title: "Git Push to Deploy",
      description:
        "Connect your repo and every push builds locally and deploys automatically — preview branches and staging environments included.",
      points: [
        "Automatic deploys on every push to main",
        "Preview deployments for every pull request",
        "Branch-based staging environments",
      ],
      Visual: GitVisual,
      accent: "violet",
      bg: "https://framerusercontent.com/images/WUXubbFykMGhPqFWRwQRozQM.jpg",
      color: "rgba(255,255,255,1)",
      overlay: "rgba(0,0,0,0.82)",
    },
    {
      title: "Instant Rollbacks",
      description:
        "Every deployment is an immutable snapshot. Roll back to any previous version in one click with zero downtime.",
      points: [
        "Immutable versioned snapshots of every deploy",
        "One-click rollback — zero downtime",
        "Full deployment history with diffs",
      ],
      Visual: RollbackVisual,
      accent: "amber",
      bg: "https://framerusercontent.com/images/gCvZUfjCAtNS7imiZz6gZGE0LE.jpg",
      color: "rgba(255,255,255,1)",
      overlay: "rgba(0,0,0,0.82)",
    },
    {
      title: "Any Stack, Any Language",
      description:
        "Node.js, Python, Go, Rust, PHP, Ruby — if it builds, Openship ships it. Your framework is detected and the build is configured automatically.",
      points: [
        "Auto-detects language, framework, and build command",
        "Full Dockerfile support for custom setups",
        "Monorepo support — deploy any sub-path",
      ],
      Visual: StacksVisual,
      accent: "violet",
      bg: "https://framerusercontent.com/images/DWC8UZeRiKEKDpUceDrVk7IfyA.jpg",
      color: "rgba(255,255,255,1)",
      overlay: "rgba(0,0,0,0.82)",
    },
    {
      title: "Free SSL & Custom Domains",
      description:
        "Automatic SSL certificates with Let's Encrypt. Unlimited custom domains with wildcard support — all free, all automatic.",
      points: [
        "Auto-provisioned SSL via Let's Encrypt",
        "Unlimited custom domains & wildcards",
        "Automatic renewal — zero maintenance",
      ],
      Visual: SslVisual,
      accent: "amber",
      bg: "https://framerusercontent.com/images/TquFwq0VjZoGsaKv8WjwTRQhLc.jpg",
      color: "rgba(255,255,255,1)",
      overlay: "rgba(0,0,0,0.82)",
    },
  ];

/* ─── Checkmark icon ────────────────────────────────────────── */
function Check({ accent: _ }: { accent: "violet" | "amber" }) {
  return (
    <svg
      className="mt-[3px] h-4 w-4 shrink-0"
      style={{ color: "rgba(255,255,255,.7)" }}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2.5}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

const allowBlob = false

/* ─── Component ─────────────────────────────────────────────── */
export function Features() {
  const containerRef = useGsapScroll();
  const { leftRef, rightRef } = useEdgeBlobs(allowBlob);
  const { svgRef, rightRef: borderRightRef, leftRef: borderLeftRef, dividersRef } = useDrawBorder();

  return (
    <>
      {allowBlob && <>
        {/* ── Fixed edge aurora — multi-shade, scroll-linked ── */}
        <div
          ref={leftRef}
          className="feat-edge-aurora feat-edge-aurora--left"
          style={{
            "--lc": BLOB_PALETTE[0].lCore, "--lu": BLOB_PALETTE[0].lUp, "--ll": BLOB_PALETTE[0].lLo,
            "--rc": BLOB_PALETTE[0].rCore, "--ru": BLOB_PALETTE[0].rUp, "--rl": BLOB_PALETTE[0].rLo,
          } as React.CSSProperties}
          aria-hidden="true"
        >
          <span className="feat-edge-aurora__core" />
          <span className="feat-edge-aurora__wing feat-edge-aurora__wing--upper" />
          <span className="feat-edge-aurora__wing feat-edge-aurora__wing--lower" />
        </div>
        <div
          ref={rightRef}
          className="feat-edge-aurora feat-edge-aurora--right"
          style={{
            "--lc": BLOB_PALETTE[0].lCore, "--lu": BLOB_PALETTE[0].lUp, "--ll": BLOB_PALETTE[0].lLo,
            "--rc": BLOB_PALETTE[0].rCore, "--ru": BLOB_PALETTE[0].rUp, "--rl": BLOB_PALETTE[0].rLo,
          } as React.CSSProperties}
          aria-hidden="true"
        >
          <span className="feat-edge-aurora__core" />
          <span className="feat-edge-aurora__wing feat-edge-aurora__wing--upper" />
          <span className="feat-edge-aurora__wing feat-edge-aurora__wing--lower" />
        </div>
      </>}
      <section id="features" className="feat-outer">
        <DarkSection>
          <div className="feat-section relative">
            {/* ── Scroll-drawn SVG border (lives in section, not container, so it can be wider) ── */}
            <svg
              ref={svgRef}
              className="feat-draw-border"
              aria-hidden="true"
            >
              <path ref={borderRightRef} className="feat-draw-border__path" />
              <path ref={borderLeftRef} className="feat-draw-border__path" />
              <g ref={dividersRef} />
            </svg>

            <div ref={containerRef} className="feat-container mx-auto max-w-[1120px] px-5 sm:px-8 relative">
              {/* ── Header ──────────────────────────────────────── */}
              <div className="feat-header mx-auto max-w-2xl text-center pt-28 sm:pt-36 pb-16 sm:pb-20">
                <p className="mb-3 text-[12px] font-semibold uppercase tracking-[0.15em]" style={{ color: 'rgba(255,255,255,.38)' }}>
                  Platform
                </p>
                <h2 className="text-[clamp(1.75rem,4vw,2.75rem)] font-semibold tracking-[-0.025em] leading-[1.15]" style={{ color: 'rgba(255,255,255,1)' }}>
                  Everything between your code and production
                </h2>
                <p className="mt-4 text-[16px] leading-[1.65]" style={{ color: 'rgba(255,255,255,.50)' }}>
                  We handle the config. You handle the code. Ship in minutes.
                </p>
              </div>

              {/* ── Feature cards ───────────────────────────────── */}
              <div className="feat-cards-grid">
                {FEATURES.map((f, i) => {
                  const isRight = i % 2 !== 0;
                  return (
                    <div key={f.title} className="feat-card" data-accent={f.accent}>
                      {/* Inner grid: text + visual */}
                      <div
                        className={`feat-card-inner ${isRight ? "feat-card-inner--reverse" : ""}`}
                      >
                        {/* Text side */}
                        <div className="feat-card-text">
                          <h3 className="text-[clamp(1.5rem,3.2vw,2rem)] font-semibold tracking-[-0.025em] leading-[1.15] mb-4" style={{ color: 'rgba(255,255,255,.95)' }}>
                            {f.title}
                          </h3>
                          <p className="text-[16px] leading-[1.7]" style={{ color: 'rgba(255,255,255,.50)' }}>
                            {f.description}
                          </p>
                          <ul className="feat-bullets mt-5 space-y-3">
                            {f.points.map((p) => (
                              <li key={p} className="flex items-start gap-2.5">
                                <Check accent={f.accent} />
                                <span className="text-[15px] leading-[1.55]" style={{ color: 'rgba(255,255,255,.45)' }}>
                                  {p}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        {/* Visual side — locked width */}
                        <div
                          className="feat-card-visual"
                          style={{
                            '--v-bg-img': f.bg ? `url(${f.bg})` : 'none',
                            '--v-overlay': f.overlay,
                            '--v-backdrop': f.backdropFilter ?? 'none',
                            color: f.color,
                          } as React.CSSProperties}
                        >
                          <f.Visual />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Bottom breathing room */}
              <div className="h-16 sm:h-24" />
            </div>
          </div>
        </DarkSection>
      </section>
    </>
  );
}
