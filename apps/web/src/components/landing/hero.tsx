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
      <div className="relative z-10 mx-auto w-full max-w-[860px] px-6 text-center">
        {/* Badge */}
        <div className="animate-fade-in-up mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--th-accent-violet)] opacity-50" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--th-accent-violet)]" />
          </span>
          <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
            Open Source &middot; Self-Hostable
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
        <p className="animate-fade-in-up animate-delay-200 mx-auto mt-6 max-w-[480px] text-[16px] leading-[1.65] th-text-body">
          The open-source deployment platform with native microservices, AI&nbsp;builds, and&nbsp;one&#8209;click&nbsp;infrastructure&nbsp;— self&#8209;host&nbsp;it or&nbsp;let&nbsp;us&nbsp;run&nbsp;it.
        </p>

        {/* CTAs */}
        <div className="animate-fade-in-up animate-delay-300 mt-9 flex flex-col items-center justify-center gap-3.5 sm:flex-row">
          <a
            href="/login"
            className="th-btn group rounded-full px-7 py-3 text-[15px] font-medium"
          >
            Start Deploying
            <svg className="ml-1.5 h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </a>
          <a
            href="https://github.com/oblien/openship"
            target="_blank"
            rel="noopener noreferrer"
            className="th-btn-ghost rounded-full px-7 py-3 text-[15px]"
          >
            <svg className="h-[18px] w-[18px]" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            Star on GitHub
          </a>
        </div>
      </div>

      {/* ═══════════════ Stack ticker ═══════════════ */}
      <div className="animate-fade-in-up animate-delay-500 relative z-10 mt-16 w-full max-w-[820px] px-6">
        <p className="mb-5 text-center text-[13px] font-medium uppercase tracking-[0.1em] th-text-muted">
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
