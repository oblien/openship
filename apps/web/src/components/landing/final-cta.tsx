"use client";

export function FinalCta() {
  return (
    <section className="relative py-28 sm:py-36">
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        <div className="relative overflow-hidden rounded-3xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] px-8 py-16 shadow-[0_8px_40px_rgba(0,0,0,.06)] sm:px-14 sm:py-20">
          {/* Ambient blobs */}
          <div
            className="pointer-events-none absolute -left-24 -top-24 h-[300px] w-[300px] rounded-full blur-[80px]"
            style={{ background: "var(--th-clr-plum-blob)" }}
          />
          <div
            className="pointer-events-none absolute -bottom-20 -right-20 h-[260px] w-[260px] rounded-full blur-[80px]"
            style={{ background: "var(--th-clr-sea-blob)" }}
          />
          <div
            className="pointer-events-none absolute right-1/3 top-1/4 h-[180px] w-[180px] rounded-full blur-[60px]"
            style={{ background: "var(--th-clr-terra-blob)" }}
          />

          {/* Grid lines (decorative) */}
          <div className="pointer-events-none absolute inset-0 opacity-[0.03]" style={{
            backgroundImage: "linear-gradient(var(--th-on-100) 1px, transparent 1px), linear-gradient(90deg, var(--th-on-100) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }} />

          <div className="relative text-center">
            {/* Terminal-style prompt */}
            <div className="mx-auto mb-8 inline-flex items-center gap-2.5 rounded-full border border-[var(--th-on-06)] bg-white/70 px-5 py-2 font-mono text-[13px] shadow-[0_2px_8px_rgba(0,0,0,.04)] backdrop-blur-sm">
              <span style={{ color: "var(--th-clr-sea)" }}>$</span>
              <span className="th-text-secondary">git push origin main</span>
              <span className="animate-pulse th-text-muted">▌</span>
            </div>

            <h2>
              <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
                Ready to ship?
              </span>
              <span
                className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
                style={{ color: "var(--th-on-40)" }}
              >
                Deploy in minutes.
              </span>
            </h2>

            <p className="mx-auto mt-6 max-w-lg text-[16px] leading-[1.65] th-text-body">
              Use our cloud or deploy to your own servers. No credit card,
              no vendor lock-in, no surprises. Start free in seconds.
            </p>

            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <a
                href="/login"
                className="th-btn group rounded-full px-8 py-3.5 text-[15px] font-medium"
              >
                Start Free
                <svg
                  className="ml-1.5 h-4 w-4 transition-transform group-hover:translate-x-0.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </a>
              <a
                href="https://github.com/openshiporg/openship"
                target="_blank"
                rel="noopener noreferrer"
                className="th-btn-ghost rounded-full px-8 py-3.5 text-[15px] font-medium"
              >
                <svg className="mr-2 inline-block h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                </svg>
                View on GitHub
              </a>
            </div>

            {/* Trust row */}
            <div className="mx-auto mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13px] th-text-muted">
              <span className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5" style={{ color: "var(--th-clr-sea)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                CLI, web & desktop
              </span>
              <span className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5" style={{ color: "var(--th-clr-sea)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                Cloud or self-hosted
              </span>
              <span className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5" style={{ color: "var(--th-clr-sea)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                No credit card
              </span>
              <span className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5" style={{ color: "var(--th-clr-sea)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                Open source
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
