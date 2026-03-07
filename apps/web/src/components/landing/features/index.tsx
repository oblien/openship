"use client";

import { useEffect, useRef } from "react";
import { useGsapScroll } from "@/hooks/use-gsap-scroll";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { CloudVisual } from "./cloud-visual";
import { AiVisual } from "./ai-visual";
import { GitVisual } from "./git-visual";
import { RollbackVisual } from "./rollback-visual";
import { StacksVisual } from "./stacks-visual";
import { SslVisual } from "./ssl-visual";
import { InfraVisual } from "./infra-visual";

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
      title: "Your Cloud or Ours",
      description:
        "Run on our managed cloud with auto-scaling and zero ops — or self-host on your own metal. Same platform, your rules.",
      points: [
        "Managed cloud with automatic scaling to zero",
        "Self-host anywhere — any Linux box, any provider",
        "Migrate between managed and self-hosted any time",
      ],
      Visual: CloudVisual,
      accent: "violet",
      bg: "https://framerusercontent.com/images/DWC8UZeRiKEKDpUceDrVk7IfyA.jpg",
      color: "rgba(0,0,0,1)",
      overlay: "rgba(255,255,255,0.9)",
    },
    {
      title: "Native Microservices",
      description:
        "Stop juggling providers. Spin up your API, database, Redis, WebSocket server, workers — your entire backend stack from one UI. One click.",
      points: [
        "Add Postgres, Redis, MongoDB in one click",
        "Built-in API gateway, WebSocket & worker support",
        "Private networking between services — zero config",
      ],
      Visual: InfraVisual,
      accent: "amber",
      bg: "https://framerusercontent.com/images/RPfj9rnNJTScxvWiCwQ189Xde0.jpg",
      color: "rgba(0,0,0,1)",
      overlay: "rgba(255,255,255,0.9)",
    },
    {
      title: "AI-Powered Builds",
      description:
        "A built-in AI agent watches every build. When something breaks it diagnoses the root cause and can apply the fix automatically.",
      points: [
        "Automatic error detection and root-cause analysis",
        "One-click AI fix for common build failures",
        "Learns your project patterns over time",
      ],
      Visual: AiVisual,
      accent: "violet",
      bg: "https://framerusercontent.com/images/H1DkziaAiY3dL9msAC3bwGQqJY.jpg",
      color: "rgba(0,0,0,1)",
      overlay: "rgba(255,255,255,0.9)",
    },
    {
      title: "Git Push to Deploy",
      description:
        "Connect your repo. Every push triggers an automatic build & deploy — preview branches and staging environments included.",
      points: [
        "Automatic deploys on every push to main",
        "Preview deployments for every pull request",
        "Branch-based staging environments",
      ],
      Visual: GitVisual,
      accent: "violet",
      bg: "https://framerusercontent.com/images/WUXubbFykMGhPqFWRwQRozQM.jpg",
      color: "rgba(0,0,0,1)",
      overlay: "rgba(255,255,255,0.9)",
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
      color: "rgba(0,0,0,1)",
      overlay: "rgba(255,255,255,0.9)",
    },
    {
      title: "Any Stack, Any Language",
      description:
        "Node.js, Python, Go, Rust, PHP, Ruby — if it builds, it ships. First-class Dockerfile support and automatic buildpack detection.",
      points: [
        "Auto-detect language, framework, and build command",
        "Full Dockerfile support for custom setups",
        "Monorepo support — deploy any sub-path",
      ],
      Visual: StacksVisual,
      accent: "violet",
      bg: "https://framerusercontent.com/images/DWC8UZeRiKEKDpUceDrVk7IfyA.jpg",
      color: "rgba(0,0,0,1)",
      overlay: "rgba(255,255,255,0.9)",
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
      color: "rgba(0,0,0,1)",
      overlay: "rgba(255,255,255,0.9)",
    },
  ];

/* ─── Checkmark icon ────────────────────────────────────────── */
function Check({ accent: _ }: { accent: "violet" | "amber" }) {
  return (
    <svg
      className="mt-[3px] h-4 w-4 shrink-0"
      style={{ color: "#000" }}
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
      <section id="features" className="feat-section relative overflow-hidden">

        <div ref={containerRef} className="mx-auto max-w-[1120px] px-5 sm:px-8">
          {/* ── Header ──────────────────────────────────────── */}
          <div className="feat-header mx-auto max-w-2xl text-center pt-28 sm:pt-36 pb-16 sm:pb-20">
            <p className="th-text-muted mb-3 text-[12px] font-semibold uppercase tracking-[0.15em]">
              Platform
            </p>
            <h2 className="th-text-heading text-[clamp(1.75rem,4vw,2.75rem)] font-semibold tracking-[-0.025em] leading-[1.15]">
              Everything you need to ship
            </h2>
            <p className="th-text-body mt-4 text-[16px] leading-[1.65]">
              A complete deployment platform — from push to production.
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
                      <h3 className="th-text-heading text-[clamp(1.5rem,3.2vw,2rem)] font-semibold tracking-[-0.025em] leading-[1.15] mb-4">
                        {f.title}
                      </h3>
                      <p className="th-text-body text-[16px] leading-[1.7]">
                        {f.description}
                      </p>
                      <ul className="feat-bullets mt-5 space-y-3">
                        {f.points.map((p) => (
                          <li key={p} className="flex items-start gap-2.5">
                            <Check accent={f.accent} />
                            <span className="text-[15px] leading-[1.55] th-text-secondary">
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
      </section>
    </>
  );
}
