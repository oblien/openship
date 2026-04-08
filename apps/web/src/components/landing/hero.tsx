"use client";

import { useState } from "react";

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
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText("npm i -g openship");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
        {/* Install command */}
        <button
          onClick={handleCopy}
          className="animate-fade-in-up group mb-7 inline-flex items-center gap-2 font-mono text-[13px] tracking-[0.01em] th-text-muted transition-colors hover:th-text-secondary"
        >
          <span className="opacity-50">$</span>
          <span>npm i -g openship</span>
          <span className="ml-0.5 opacity-0 transition-opacity group-hover:opacity-50">
            {copied ? (
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
              </svg>
            )}
          </span>
        </button>

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
          Push your code - builds, config, and deployment are handled automatically. Use our cloud or connect your own servers. Zero&nbsp;lock&#8209;in, completely&nbsp;open&#8209;source.
        </p>

        {/* CTAs */}
        <div className="animate-fade-in-up animate-delay-300 mt-9 flex flex-col items-center gap-5">
          <div className="flex items-center justify-center gap-3.5">
            <a
              href="/docs"
              className="th-btn group rounded-full px-7 py-3 text-[15px] font-medium"
            >
              Get Started
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