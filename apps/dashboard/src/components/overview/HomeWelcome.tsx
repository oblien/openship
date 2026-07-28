"use client";

import React from "react";
import Link from "next/link";
import { Plus, Github } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

/**
 * First-run welcome shown on the home page when the user has no projects.
 *
 * The motif is what Openship IS: the brand mark at the centre, wired to the four
 * things it handles — repo in, build/deploy, data, public domain.
 *
 * TOKENS: only steps that EXIST in styles/theme.css. The --th-on-* scale is
 * 05/08/10/12/16/20/30/40/50+ — an in-between step like --th-on-35 resolves to
 * nothing, the stroke never paints, and the tile renders EMPTY. That is exactly
 * what happened to the first version of this illustration.
 *
 * Kept compact: this renders INSIDE the home page's Projects card, directly above
 * the 4 shortcut cards — every extra 40px pushes those below the fold.
 */

/** Rounded tile + its glyph, centred on (x, y). Glyphs are hand-drawn: an icon
 *  font/component can't be embedded in the same SVG coordinate space. */
function Node({
  x,
  y,
  children,
}: {
  x: number;
  y: number;
  children: React.ReactNode;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect
        x="-19"
        y="-17"
        width="38"
        height="34"
        rx="10"
        fill="var(--th-card-bg)"
        stroke="var(--th-bd-default)"
        strokeWidth="1.5"
      />
      <g
        fill="none"
        stroke="var(--th-on-40)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </g>
    </g>
  );
}

/** Label under each tile — names what the node is, so the graph reads without a key. */
function NodeLabel({ x, y, children }: { x: number; y: number; children: string }) {
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      fill="var(--th-on-30)"
      fontSize="7"
      fontWeight="500"
      style={{ fontFamily: "inherit", letterSpacing: "0.02em" }}
    >
      {children}
    </text>
  );
}
const HomeWelcome: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="px-6 pt-5 pb-7 sm:pt-7 sm:pb-8">
      {/* Illustration — the graph: hub ↔ repo / services / data / domain */}
      <div className="relative mx-auto mb-3 h-36 w-72">
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 288 132" fill="none" aria-hidden="true">
          {/* Links, behind everything. Dashed = wiring; --th-on-20 is a real step. */}
          <g stroke="var(--th-on-20)" strokeWidth="1.5" strokeDasharray="4 4" fill="none">
            <path d="M71 32 Q 100 42 123 58" />
            <path d="M71 96 Q 100 90 123 74" />
            <path d="M165 58 Q 188 42 217 32" />
            <path d="M165 74 Q 188 90 217 96" />
          </g>
          {/* Packets sit ON their curve: a quadratic's t=0.5 point is
              0.25*P0 + 0.5*C + 0.25*P1, NOT the midpoint of the endpoints —
              eyeballing it is what left them floating beside the line. */}
          <circle cx="98.5" cy="43.5" r="2.4" fill="var(--th-on-30)" />
          <circle cx="98.5" cy="87.5" r="2" fill="var(--th-on-20)" />
          <circle cx="189.5" cy="43.5" r="2.4" fill="var(--th-on-30)" />
          <circle cx="189.5" cy="87.5" r="2" fill="var(--th-on-20)" />

          {/* Repo */}
          <Node x={52} y={32}>
            <circle cx="-6" cy="5" r="3.2" />
            <circle cx="6" cy="-6" r="3.2" />
            <path d="M-6 1.8v-3.8a4 4 0 0 1 4-4h4.8" />
          </Node>
          <NodeLabel x={52} y={60}>Repo</NodeLabel>

          {/* Deploy — the build shipping upward. */}
          <Node x={52} y={96}>
            <path d="M0 7V-6" />
            <path d="M-5 -1l5 -5.5 5 5.5" />
            <path d="M-7 9.5h14" />
          </Node>
          <NodeLabel x={52} y={124}>Deploy</NodeLabel>

          {/* Domain */}
          <Node x={236} y={32}>
            <circle cx="0" cy="0" r="8" />
            <path d="M-8 0h16" />
            <path d="M0 -8c4 3.6 4 12.4 0 16" />
            <path d="M0 -8c-4 3.6-4 12.4 0 16" />
          </Node>
          <NodeLabel x={236} y={60}>Domain</NodeLabel>

          {/* Data */}
          <Node x={236} y={96}>
            <ellipse cx="0" cy="-5" rx="8" ry="3" />
            <path d="M-8 -5v9.5c0 1.7 3.6 3 8 3s8-1.3 8-3V-5" />
            <path d="M-8 -0.5c0 1.7 3.6 3 8 3s8-1.3 8-3" />
          </Node>
          <NodeLabel x={236} y={124}>Data</NodeLabel>

          {/* Hub = the Openship mark: the ring (components/logo.tsx,
              public/apple-touch-icon.png). Soft halo for presence, no plate —
              a ring inside a filled circle reads as a target. */}
          <circle cx="144" cy="66" r="27" fill="var(--th-on-04)" />
          <circle cx="144" cy="66" r="18" fill="none" stroke="var(--th-on-80)" strokeWidth="3.5" />
          {/* Live dot on the ring's edge — the one spot of colour. */}
          <circle cx="158" cy="52" r="4.2" fill="var(--th-card-bg)" />
          <circle cx="158" cy="52" r="2.8" fill="#22c55e" fillOpacity="0.85" />
        </svg>
      </div>

      {/* Copy */}
      <div className="text-center">
        <h3 className="mb-1.5 text-xl font-medium text-foreground/85" style={{ letterSpacing: "-0.2px" }}>
          {t.overview.welcome.title}
        </h3>
        <p className="mx-auto mb-5 max-w-sm text-sm leading-relaxed text-muted-foreground/80">
          {t.overview.welcome.subtitle}
        </p>

        {/* CTAs */}
        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/library"
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25"
          >
            <Plus className="size-4" />
            {t.overview.welcome.createProject}
          </Link>
          <Link
            href="/library"
            className="inline-flex items-center gap-2 rounded-xl bg-muted/50 px-6 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Github className="size-4" />
            {t.overview.welcome.importGithub}
          </Link>
        </div>
      </div>

      <p className="mt-5 text-center text-xs text-muted-foreground/60">
        {t.overview.welcome.tipPrefix}{" "}
        <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘ K</kbd>{" "}
        {t.overview.welcome.tipSuffix}
      </p>
    </div>
  );
};

export default HomeWelcome;
