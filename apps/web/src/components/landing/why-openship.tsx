/* ── Why Openship — architectural advantages over alternatives ── */

const DIFFERENTIATORS = [
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z" />
      </svg>
    ),
    title: "Builds run locally by default",
    desc: "Other tools build directly on your production server — eating CPU and RAM your apps need. Openship builds on your machine and only pushes production-ready containers. Need server-side builds for architecture compatibility? Toggle it on — you choose.",
    highlight: "Your server stays fast — builds are offloaded",
    color: "var(--th-clr-plum)",
    bg: "var(--th-clr-plum-bg)",
    blob: "var(--th-clr-plum-blob)",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
      </svg>
    ),
    title: "Skip CI/CD. Just deploy.",
    desc: "No pipelines to configure, no build servers to maintain, no YAML to write. Run openship deploy — it builds, tests, and ships. When your team needs full CI/CD, it's there too.",
    highlight: "CI/CD replaced by a single command — available when you need it",
    color: "var(--th-clr-sea)",
    bg: "var(--th-clr-sea-bg)",
    blob: "var(--th-clr-sea-blob)",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
      </svg>
    ),
    title: "Auto-detected. Auto-configured.",
    desc: "Other tools still expect you to know Docker, NGINX, and reverse proxies. Openship detects your stack, writes the config, sets up SSL, and deploys — no manual setup, no YAML to write.",
    highlight: "Zero infrastructure knowledge required",
    color: "var(--th-clr-terra)",
    bg: "var(--th-clr-terra-bg)",
    blob: "var(--th-clr-terra-blob)",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
      </svg>
    ),
    title: "Nothing extra installed on your server",
    desc: "Coolify and CapRover install a web dashboard, build system, and management layer on the server. Openship keeps your server clean — just your apps running in production. Works on any Linux box or VPS, any provider.",
    highlight: "Your server only runs what you shipped",
    color: "var(--th-clr-plum)",
    bg: "var(--th-clr-plum-bg)",
    blob: "var(--th-clr-plum-blob)",
  },
];

/* ── Comparison table ── */
const COMPARE_ROWS: { feature: string; openship: string; others: string; win?: boolean }[] = [
  { feature: "Where builds run", openship: "Local (or server when needed)", others: "Always on the server", win: true },
  { feature: "Server overhead", openship: "Your apps only", others: "Dashboard + build system + DB", win: true },
  { feature: "CI/CD", openship: "Built-in (or click to deploy)", others: "Configure pipelines & webhooks", win: true },
  { feature: "Configuration", openship: "Auto-detected & configured", others: "Manual YAML / Docker Compose", win: true },
  { feature: "Deployment interface", openship: "CLI, web dashboard, or desktop app", others: "Web dashboard on server", win: true },
  { feature: "Server resources used for builds", openship: "0% by default", others: "Competes with production", win: true },
  { feature: "Infrastructure knowledge", openship: "None required", others: "Docker, NGINX, SSH", win: true },
  { feature: "Managed cloud option", openship: "Yes — fully managed", others: "Self-host only", win: true },
  { feature: "Open source", openship: "MIT", others: "Varies (MIT / AGPL)", },
];

export function WhyOpenship() {
  return (
    <section className="relative py-28 sm:py-36">
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* ── Header ── */}
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
            <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
              Why Openship
            </span>
          </div>
          <h2>
            <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
              Not another server tool.
            </span>
            <span
              className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
              style={{ color: "var(--th-on-40)" }}
            >
              A smarter architecture.
            </span>
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-[1.65] th-text-body">
            Coolify, CapRover, and Dokku all install on your server and build there too.
            Openship builds locally by default — your server only runs production.
            Need server-side builds? CI/CD? A web dashboard? It&apos;s all there.
            Fully managed cloud or completely self-hosted — same platform, your call.
          </p>
        </div>

        {/* ── Architecture diagram ── */}
        <div className="mx-auto mt-16 max-w-4xl">
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Other tools */}
            <div className="rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-6 shadow-[var(--th-card-shadow)]">
              <div className="mb-4 flex items-center gap-3">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-xl"
                  style={{ background: "var(--th-clr-terra-bg)", color: "var(--th-clr-terra)" }}
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                </div>
                <div>
                  <p className="text-[14px] font-bold th-text-heading">Other self-hosting tools</p>
                  <p className="text-[12px] th-text-muted">Coolify · CapRover · Dokku</p>
                </div>
              </div>

              <div className="space-y-2 rounded-xl border border-[var(--th-card-bd)] bg-[var(--th-sf-01)] p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.08em] th-text-muted">Your server runs:</p>
                <div className="space-y-1.5">
                  {[
                    "Management dashboard (web UI)",
                    "Build system (compiles your code)",
                    "CI/CD pipeline engine",
                    "Database for the tool itself",
                    "Reverse proxy config",
                    "Your actual apps",
                  ].map((item) => (
                    <div key={item} className="flex items-center gap-2 text-[13px]">
                      <span
                        className="h-1.5 w-1.5 rounded-full shrink-0"
                        style={{ background: "var(--th-clr-terra)" }}
                      />
                      <span className="th-text-body">{item}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 rounded-lg px-3 py-2 text-[12px] font-medium" style={{ background: "var(--th-clr-terra-wash)", color: "var(--th-clr-terra)" }}>
                  Server resources split between builds and production
                </p>
              </div>
            </div>

            {/* Openship */}
            <div className="rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-6 shadow-[var(--th-card-shadow)]">
              <div className="mb-4 flex items-center gap-3">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-xl"
                  style={{ background: "var(--th-clr-sea-bg)", color: "var(--th-clr-sea)" }}
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-[14px] font-bold th-text-heading">Openship</p>
                  <p className="text-[12px] th-text-muted">Flexible architecture</p>
                </div>
              </div>

              <div className="space-y-3">
                <div className="rounded-xl border border-[var(--th-card-bd)] bg-[var(--th-sf-01)] p-4">
                  <p className="text-[11px] font-bold uppercase tracking-[0.08em] th-text-muted">Your machine runs:</p>
                  <div className="mt-2 space-y-1.5">
                    {["CLI or desktop app (UI + build engine)", "Build system (compiles locally)", "Configuration engine"].map((item) => (
                      <div key={item} className="flex items-center gap-2 text-[13px]">
                        <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: "var(--th-clr-plum)" }} />
                        <span className="th-text-body">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-center">
                  <svg className="h-5 w-5 th-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
                  </svg>
                  <span className="ml-2 text-[11px] font-medium th-text-muted">Production containers only</span>
                </div>

                <div className="rounded-xl border border-[var(--th-card-bd)] bg-[var(--th-sf-01)] p-4">
                  <p className="text-[11px] font-bold uppercase tracking-[0.08em] th-text-muted">Your server runs:</p>
                  <div className="mt-2 space-y-1.5">
                    {["Your apps (production containers)", "Nothing else — no build system, no dashboard, no DB"].map((item) => (
                      <div key={item} className="flex items-center gap-2 text-[13px]">
                        <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: "var(--th-clr-sea)" }} />
                        <span className="th-text-body">{item}</span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 rounded-lg px-3 py-2 text-[12px] font-medium" style={{ background: "var(--th-clr-sea-wash)", color: "var(--th-clr-sea)" }}>
                    100% of server resources for your apps
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Differentiator cards ── */}
        <div className="mx-auto mt-16 grid max-w-6xl gap-5 sm:grid-cols-2">
          {DIFFERENTIATORS.map((d) => (
            <div
              key={d.title}
              className="group relative overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-7 shadow-[var(--th-card-shadow)] transition-colors hover:border-[var(--th-card-bd-hover)]"
            >
              {/* Ambient blob */}
              <div
                className="pointer-events-none absolute -right-12 -top-12 h-[160px] w-[160px] rounded-full blur-[60px] opacity-60"
                style={{ background: d.blob }}
              />

              <div className="relative">
                <div
                  className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl"
                  style={{ background: d.bg, color: d.color }}
                >
                  {d.icon}
                </div>

                <h3 className="text-[18px] font-bold leading-tight tracking-tight th-text-heading">
                  {d.title}
                </h3>
                <p className="mt-2.5 text-[14px] leading-[1.65] th-text-body">
                  {d.desc}
                </p>
                <p
                  className="mt-4 inline-block rounded-full px-3.5 py-1 text-[12px] font-semibold"
                  style={{ background: d.bg, color: d.color }}
                >
                  {d.highlight}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* ── Comparison table ── */}
        <div className="mx-auto mt-16 max-w-5xl overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] shadow-[var(--th-card-shadow)]">
          {/* Header row */}
          <div className="grid grid-cols-[1fr_180px_180px] sm:grid-cols-[1fr_220px_220px] border-b-2 border-[var(--th-card-bd)] bg-[var(--th-sf-02)] px-6 py-4">
            <span className="text-[13px] font-bold uppercase tracking-[0.08em] th-text-muted" />
            <span className="text-center text-[14px] font-bold th-text-heading">
              🚀 Openship
            </span>
            <span className="text-center text-[14px] font-bold th-text-muted">
              Others
            </span>
          </div>

          {/* Data rows */}
          {COMPARE_ROWS.map((r, i) => (
            <div
              key={r.feature}
              className="grid grid-cols-[1fr_180px_180px] sm:grid-cols-[1fr_220px_220px] items-center border-t border-[var(--th-card-bd)] px-6 py-3.5"
              style={{ background: i % 2 === 0 ? "transparent" : "var(--th-sf-01)" }}
            >
              <span className="text-[14px] font-medium th-text-heading">
                {r.feature}
              </span>
              <span className="text-center">
                <span
                  className="inline-block rounded-full px-3 py-0.5 text-[12px] font-semibold"
                  style={{ background: "var(--th-clr-sea-wash)", color: "var(--th-clr-sea)" }}
                >
                  {r.openship}
                </span>
              </span>
              <span className="text-center">
                <span
                  className="inline-block rounded-full px-3 py-0.5 text-[12px] font-medium"
                  style={{
                    background: r.win ? "var(--th-clr-terra-wash)" : "var(--th-sf-04)",
                    color: r.win ? "var(--th-clr-terra)" : "var(--th-text-secondary)",
                  }}
                >
                  {r.others}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
