"use client";

import { DownloadButton } from "./download-button";

const STACKS = [
  { name: 'Next.js',     icon: 'https://cdn.simpleicons.org/nextdotjs/000000' },
  { name: 'Node',        icon: 'https://cdn.simpleicons.org/nodedotjs/5FA04E' },
  { name: 'Python',      icon: 'https://cdn.simpleicons.org/python/3776AB' },
  { name: 'Go',          icon: 'https://cdn.simpleicons.org/go/00ADD8' },
  { name: 'Rust',        icon: 'https://cdn.simpleicons.org/rust/000000' },
  { name: 'Docker',      icon: 'https://cdn.simpleicons.org/docker/2496ED' },
  { name: 'Postgres',    icon: 'https://cdn.simpleicons.org/postgresql/4169E1' },
  { name: 'Redis',       icon: 'https://cdn.simpleicons.org/redis/FF4438' },
  { name: 'Rails',       icon: 'https://cdn.simpleicons.org/rubyonrails/D30001' },
  { name: 'Laravel',     icon: 'https://cdn.simpleicons.org/laravel/FF2D20' },
  { name: 'Django',      icon: 'https://cdn.simpleicons.org/django/092E20' },
  { name: 'Bun',         icon: 'https://cdn.simpleicons.org/bun/000000' },
];

export function Hero() {
  return (
    <section className="hero-section relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden">
      {/* ═══════════════ Background layers ═══════════════ */}
      <div className="hero-grain absolute inset-0" aria-hidden="true" />
      <div className="hero-grid absolute inset-0" aria-hidden="true" />

      {/* ── Bottom aurora glow ── */}
      <div className="hero-aurora" aria-hidden="true">
        <div className="hero-aurora-core" />
        <div className="hero-aurora-wing hero-aurora-wing--left" />
        <div className="hero-aurora-wing hero-aurora-wing--right" />
      </div>

      {/* ═══════════════ Content ═══════════════ */}
      <div className="relative z-20 mx-auto w-full max-w-[860px] px-6 text-center">
        {/* Badge */}
        <div className="animate-fade-in-up mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--th-accent-violet)] opacity-50" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--th-accent-violet)]" />
          </span>
          <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
            Open Source &middot; Cloud or Self-Hosted
          </span>
        </div>

        {/* Headline */}
        <h1 className="animate-fade-in-up animate-delay-100">
          <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
            Deploy Anything.
          </span>
          <span className="hero-headline-second block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]">
            Own Everything.
          </span>
        </h1>

        {/* Sub */}
        <p className="animate-fade-in-up animate-delay-200 mx-auto mt-6 max-w-[520px] text-[16px] leading-[1.65] th-text-body">
          Push your code&nbsp;&mdash; builds, config, and deployment are handled automatically. Use our cloud or connect your own servers. Zero&nbsp;lock&#8209;in, completely&nbsp;open&#8209;source.
        </p>

        {/* CTAs */}
        <div className="animate-fade-in-up animate-delay-300 mt-9 flex flex-col items-center justify-center gap-3.5 sm:flex-row">
          <DownloadButton size="large" />
          <a
            href="/login"
            className="th-btn-ghost group rounded-full px-7 py-3 text-[15px] font-medium"
          >
            Start Free
            <svg
              className="ml-1.5 -mr-1.5 h-4 w-4 transition-transform group-hover:translate-x-0.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </a>
        </div>
      </div>

      {/* ═══════════════ Stack ticker ═══════════════ */}
      <div className="animate-fade-in-up animate-delay-500 relative z-10 mt-16 w-full max-w-[820px] px-6">
        <p className="mb-6 text-center text-[13px] font-medium uppercase tracking-[0.1em] th-text-muted">
          Designed for your favorite stack
        </p>
        <div className="hero-ticker-mask overflow-hidden">
          <div className="hero-ticker flex w-max items-center gap-12">
            {[0, 1].map((i) => (
              <div key={i} className="flex shrink-0 items-center gap-12">
                {STACKS.map((s) => (
                  <div key={`${i}-${s.name}`} className="flex shrink-0 items-center gap-2.5 opacity-50" style={{ filter: 'grayscale(1) brightness(0.45) contrast(1.1)' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={s.icon} alt={s.name} className="h-[26px] w-[26px] object-contain" loading="lazy" />
                    <span className="whitespace-nowrap text-[14px] font-medium th-text-secondary">{s.name}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Edge fades */}
      <div className="hero-edge-fade-top absolute top-0 left-0 right-0 h-20" aria-hidden="true" />
      <div className="hero-edge-fade-bottom absolute bottom-0 left-0 right-0 h-40" aria-hidden="true" />
    </section>
  );
}