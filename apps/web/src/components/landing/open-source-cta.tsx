export function OpenSourceCta() {
  return (
    <section className="relative py-28 sm:py-36">
      {/* Divider */}
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        <div className="relative mx-auto max-w-3xl overflow-hidden rounded-2xl border border-[var(--th-bd-default)] bg-[var(--th-bg-page)]">
          {/* Subtle gradient overlay at top */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(ellipse 60% 50% at 50% -10%, rgba(129,140,248,.08), transparent)',
            }}
            aria-hidden="true"
          />

          <div className="relative px-8 py-16 text-center sm:px-16 sm:py-20">
            {/* Badge */}
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[var(--th-bd-default)] px-4 py-1.5">
              <svg className="h-4 w-4 th-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
              </svg>
              <span className="th-text-secondary text-sm font-medium">
                Open Source
              </span>
            </div>

            <h2 className="th-text-heading text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
              Free. Open Source.
              <br />
              Forever.
            </h2>

            <p className="th-text-body mx-auto mt-5 max-w-lg text-lg leading-relaxed">
              MIT licensed. Self-host on your own server, contribute to the codebase,
              or use our managed cloud. No hidden costs, no usage limits.
            </p>

            {/* Feature pills */}
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              {[
                "MIT License",
                "Free Mail Server",
                "Unlimited Domains",
                "Wildcard SSL",
                "No Usage Limits",
                "Community Driven",
              ].map((pill) => (
                <span
                  key={pill}
                  className="rounded-full border border-[var(--th-bd-default)] px-3.5 py-1.5 text-xs font-medium th-text-secondary"
                >
                  {pill}
                </span>
              ))}
            </div>

            {/* CTAs */}
            <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <a
                href="/login"
                className="th-btn rounded-xl px-8 py-3.5 text-base font-medium"
              >
                Start Self-Hosting
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </a>
              <a
                href="https://github.com/openshiporg/openship"
                target="_blank"
                rel="noopener noreferrer"
                className="th-btn-ghost rounded-xl px-8 py-3.5 text-base"
              >
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                View on GitHub
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
