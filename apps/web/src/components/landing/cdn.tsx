const EDGES = [
  { city: "Frankfurt", flag: "🇩🇪", ms: "8 ms" },
  { city: "Ashburn", flag: "🇺🇸", ms: "12 ms" },
  { city: "Singapore", flag: "🇸🇬", ms: "22 ms" },
  { city: "São Paulo", flag: "🇧🇷", ms: "34 ms" },
  { city: "Tokyo", flag: "🇯🇵", ms: "18 ms" },
  { city: "Sydney", flag: "🇦🇺", ms: "28 ms" },
];

const BULLETS = [
  "Automatic edge caching — no configuration",
  "HTTP/3 and Brotli compression out of the box",
  "Instant cache purge on every deploy",
  "Custom cache rules per route when you need them",
  "Works with any VPS — zero bottleneck on self-host",
  "No separate CDN subscription required",
];

const CHECK = (
  <svg className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--th-clr-sea)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
  </svg>
);

export function Cdn() {
  return (
    <section className="relative py-28 sm:py-36">
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* Two-column layout */}
        <div className="grid items-start gap-16 lg:grid-cols-2">
          {/* Left — text */}
          <div>
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
              <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
                Global CDN
              </span>
            </div>
            <h2>
              <span className="block text-[clamp(2.25rem,5vw,3.75rem)] font-semibold leading-[1.08] tracking-[-0.035em] th-text-heading">
                Built-in CDN.
              </span>
              <span
                className="block text-[clamp(2.25rem,5vw,3.75rem)] font-semibold leading-[1.08] tracking-[-0.035em]"
                style={{ color: "var(--th-on-40)" }}
              >
                Fast everywhere. No bottleneck.
              </span>
            </h2>
            <p className="mt-6 max-w-md text-[17px] leading-[1.65] th-text-body">
              Self-hosting doesn&apos;t mean slow. Every deploy is backed by a
              global edge network that caches and compresses automatically —
              so your self-hosted app loads just as fast as any managed platform,
              with zero extra config.
            </p>

            <ul className="mt-8 space-y-3">
              {BULLETS.map((b) => (
                <li key={b} className="flex items-start gap-2.5 text-[14px] th-text-heading">
                  {CHECK}
                  {b}
                </li>
              ))}
            </ul>
          </div>

          {/* Right — edge pops visual */}
          <div className="rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-6 shadow-[var(--th-card-shadow)]">
            <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.1em] th-text-muted">
              Edge locations
            </p>
            <div className="space-y-2">
              {EDGES.map((e) => (
                <div
                  key={e.city}
                  className="flex items-center gap-4 rounded-lg bg-[rgba(0,0,0,.02)] px-4 py-3"
                >
                  <span className="text-lg">{e.flag}</span>
                  <span className="flex-1 text-[14px] font-medium th-text-heading">
                    {e.city}
                  </span>
                  {/* latency bar */}
                  <span className="text-[13px] font-mono th-text-muted">
                    {e.ms}
                  </span>
                  <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[rgba(0,0,0,.06)]">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (parseInt(e.ms) / 40) * 100)}%`,
                        background:
                          parseInt(e.ms) <= 15
                            ? "var(--th-clr-sea)"
                            : parseInt(e.ms) <= 25
                            ? "var(--th-clr-amber)"
                            : "var(--th-clr-terra)",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
