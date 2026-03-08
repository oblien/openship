import React from "react";

/*
 * ── Curated palette ─────────────────────────────────────────
 * Now sourced from theme.css CSS custom properties.
 * Inspired by Linear / Raycast / Stripe design systems.
 */
const P = {
  // Card 1 — plum / lavender
  plum:      "var(--th-clr-plum)",
  plumSoft:  "var(--th-clr-plum-soft)",
  plumWash:  "var(--th-clr-plum-wash)",
  plumBdr:   "var(--th-clr-plum-bdr)",
  plumTag:   "var(--th-clr-plum-tag)",

  // Card 2 — terracotta / apricot
  terra:     "var(--th-clr-terra)",
  terraSoft: "var(--th-clr-terra-soft)",
  terraWash: "var(--th-clr-terra-wash)",
  terraBdr:  "var(--th-clr-terra-bdr)",
  terraTag:  "var(--th-clr-terra-tag)",

  // Card 3 — seafoam / mint
  sea:       "var(--th-clr-sea)",
  seaSoft:   "var(--th-clr-sea-soft)",
  seaWash:   "var(--th-clr-sea-wash)",
  seaBdr:    "var(--th-clr-sea-bdr)",
  seaTag:    "var(--th-clr-sea-tag)",

  // Shared
  ghost:     "var(--th-on-06, rgba(45,52,54,.06))",
};

const STEPS = [
  {
    tag: "Step 01",
    tagColor: P.plumTag,
    accent: P.plum,
    accentSoft: P.plumSoft,
    bdr: P.plumBdr,
    title: "Push your code",
    desc: "Connect your GitHub repo. Openship detects your framework, language, and build config automatically — no setup files needed.",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} className="h-7 w-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
      </svg>
    ),
    details: [
      { label: "Repo", value: "Auto-detected" },
      { label: "Framework", value: "Next.js, Rails, Go..." },
      { label: "Config", value: "AI-generated" },
    ],
  },
  {
    tag: "Step 02",
    tagColor: P.terraTag,
    accent: P.terra,
    accentSoft: P.terraSoft,
    bdr: P.terraBdr,
    title: "Connect",
    desc: "Use Openship Cloud for instant hosting, or connect your own server. AI installs Docker, sets up your environment, and provisions SSL automatically.",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} className="h-7 w-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.431.992a7.723 7.723 0 010 .255c-.007.378.138.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
    details: [
      { label: "Hosting", value: "Cloud or your server" },
      { label: "Setup", value: "AI-configured" },
      { label: "SSL", value: "Auto-provisioned" },
    ],
  },
  {
    tag: "Step 03",
    tagColor: P.seaTag,
    accent: P.sea,
    accentSoft: P.seaSoft,
    bdr: P.seaBdr,
    title: "Deploy",
    desc: "Hit deploy. AI builds your project, runs checks, and pushes production containers. Preview URLs for every PR, rollback in one click.",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} className="h-7 w-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.58-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
      </svg>
    ),
    details: [
      { label: "Build", value: "Local (your machine)" },
      { label: "Deploy", value: "34s to production" },
      { label: "URL", value: "app.example.com" },
    ],
  },
];

/* ── Arrow connector (desktop only) ─────────────────────────── */
function ConnectorArrow() {
  return (
    <div className="hidden md:flex items-center justify-center w-12 pt-12" aria-hidden="true">
      <svg
        className="w-5 h-5"
        style={{ color: "var(--th-on-10)" }}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
      </svg>
    </div>
  );
}

/* ── Component ──────────────────────────────────────────────── */
export function HowItWorks() {
  return (
    <section
      className="relative mt-[clamp(100px,12vw,180px)] max-md:mt-20 px-4"
    >
      {/* Ambient glow */}
      <div
        className="pointer-events-none absolute top-[30%] left-1/2 -translate-x-1/2 w-[700px] h-[500px] blur-[50px] z-0"
        style={{
          background: `radial-gradient(ellipse 55% 60% at 50% 50%, ${P.plumWash} 0%, ${P.terraWash} 40%, transparent 70%)`,
        }}
        aria-hidden="true"
      />

      <div className="relative z-[1] max-w-[1120px] mx-auto pb-10">
        {/* ── Header ──────────────────────────────────────── */}
        <div className="hiw-hdr text-center mb-[72px]">
          <span
            className="inline-block px-4 py-1.5 text-[12px] font-medium tracking-[0.02em] th-text-secondary rounded-full mb-6"
            style={{ background: P.ghost, border: `1px solid ${P.ghost}` }}
          >
            How It Works
          </span>
          <h2 className="text-[clamp(2.75rem,6vw,4.75rem)] font-semibold tracking-[-0.035em] leading-[1.06]">
            <span className="block th-text-heading">From your code to production</span>
            <span className="block" style={{ color: "var(--th-on-40)" }}>in minutes</span>
          </h2>
          <p className="mt-6 mx-auto max-w-[480px] text-[16px] leading-[1.65] th-text-body">
            Three steps. No terminal. That&apos;s all it takes.
          </p>
        </div>

        {/* ── Cards ───────────────────────────────────────── */}
        <div className="group grid grid-cols-1 gap-4 md:grid-cols-[1fr_48px_1fr_48px_1fr] md:gap-0">

          {STEPS.map((step, i) => (
            <React.Fragment key={step.title}>
              {i > 0 && <ConnectorArrow />}
              <div
                className="hiw-card rounded-3xl backdrop-blur-xl overflow-hidden transition-all duration-300 ease-[cubic-bezier(.22,1,.36,1)] hover:-translate-y-1.5 hover:shadow-[0_24px_64px_rgba(0,0,0,.07),0_8px_20px_rgba(0,0,0,.04)]"
                style={{
                  background: "var(--th-card-bg, rgba(255,255,255,.70))",
                  border: `1px solid ${P.ghost}`,
                  "--bdr-h": step.bdr,
                } as React.CSSProperties}
              >
                {/* Accent bar */}
                <div
                  className="h-[3px]"
                  style={{ background: `linear-gradient(90deg, ${step.accent}, ${step.accentSoft})` }}
                />
                <div className="p-6 pb-7">
                  {/* Visual panel instead of terminal */}
                  <div
                    className="mb-7 rounded-2xl p-5 flex flex-col gap-3.5"
                    style={{ background: P.ghost, border: `1px solid ${P.ghost}` }}
                  >
                    {/* Icon */}
                    <div
                      className="flex h-12 w-12 items-center justify-center rounded-xl"
                      style={{ background: `linear-gradient(135deg, ${step.accent}, ${step.accentSoft})`, color: "var(--th-btn-text)" }}
                    >
                      {step.icon}
                    </div>
                    {/* Detail rows */}
                    <div className="flex flex-col gap-2">
                      {step.details.map((d) => (
                        <div key={d.label} className="flex items-center justify-between gap-4">
                          <span className="text-[12px] th-text-muted">{d.label}</span>
                          <span className="text-[12px] font-medium th-text-heading">{d.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <span
                    className="block text-[11px] font-semibold uppercase tracking-[0.12em] mb-3.5"
                    style={{ color: step.tagColor }}
                  >
                    {step.tag}
                  </span>
                  <h3 className="text-[20px] font-semibold tracking-[-0.02em] mb-2 th-text-heading">
                    {step.title}
                  </h3>
                  <p className="text-[14px] leading-[1.65] th-text-body">
                    {step.desc}
                  </p>
                </div>
              </div>
            </React.Fragment>
          ))}

        </div>
      </div>
    </section>
  );
}
