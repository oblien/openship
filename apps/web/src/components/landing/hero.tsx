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
    <section>
      {/* ── Copy, centred under the navbar ─────────────────────────── */}
      <div className="lp-band">
        <div className="lp-band-in">
          <div className="lp-hero-dither" aria-hidden="true" />
          <div className="lp-hero-copy">
            <h1 className="lp-hero-headline animate-fade-in-up">
              <span className="block">Deploy anything.</span>
              <span className="lp-hero-headline-second block">Own everything.</span>
            </h1>

            <p className="lp-hero-sub animate-fade-in-up animate-delay-100">
              Push your code - builds, config, and deployment are handled automatically. Use our cloud or connect your own servers. Zero&nbsp;lock&#8209;in, completely&nbsp;open&#8209;source.
            </p>

            <div className="lp-hero-cta-row animate-fade-in-up animate-delay-200">
              <a href="/login" className="lp-hero-btn lp-hero-btn--primary">
                Get started
                <svg className="lp-hero-btn-arrow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 17L17 7m0 0H9m8 0v8" />
                </svg>
              </a>
              <a href="/docs/getting-started/quickstart" className="lp-hero-btn lp-hero-btn--ghost">
                Self host
                <svg className="lp-hero-btn-arrow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 17L17 7m0 0H9m8 0v8" />
                </svg>
              </a>
            </div>

            <button
              onClick={handleCopy}
              className="lp-hero-install animate-fade-in-up animate-delay-300 font-mono"
            >
              <span className="lp-hero-install-sigil">$</span>
              <span>npm i -g openship</span>
              <span className="lp-hero-install-icon">
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
          </div>
        </div>
      </div>

      {/* ── Stack ticker ───────────────────────────────────────────── */}
      <div className="lp-band">
        <div className="lp-band-in lp-hero-stacks">
          <p className="lp-hero-stacks-label">Designed for your favorite stack</p>
          <div className="hero-ticker-mask overflow-hidden">
            <div className="hero-ticker flex w-max items-center gap-12">
              {[0, 1].map((i) => (
                <div key={i} className="flex shrink-0 items-center gap-12">
                  {STACKS.map((s) => (
                    <div key={`${i}-${s.name}`} className="lp-hero-stack-item">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.icon} alt={s.name} className="h-[32px] w-[32px] object-contain" loading="lazy" />
                      <span className="whitespace-nowrap">{s.name}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Brand band ─────────────────────────────────────────────── */}
      {/* data-section marks it for the navbar's contrast switch, the same
          way the other dark plates on the site do. */}
      <div className="lp-band">
        <div className="lp-band-in lp-band-in--flush">
          <div className="lp-hero-plate" data-section="dark" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
