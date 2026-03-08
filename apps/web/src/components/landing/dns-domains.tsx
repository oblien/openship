const STEPS = [
  {
    step: "1",
    title: "Add your domain",
    desc: "Type it in — apex, subdomain, or full wildcard. app.example.com, *.example.com, you name it.",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
      </svg>
    ),
  },
  {
    step: "2",
    title: "Copy DNS records",
    desc: "One A record, one wildcard CNAME. We show you exactly what to paste — works with every DNS provider.",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
      </svg>
    ),
  },
  {
    step: "3",
    title: "Wildcard SSL — done",
    desc: "Wildcard certificates are issued and renewed automatically. Every subdomain is covered — *.yoursite.com, all HTTPS, zero config.",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
    ),
  },
];

const HIGHLIGHTS = [
  "Wildcard subdomains",
  "Apex domains",
  "Auto-renew SSL",
  "Unlimited domains",
  "No Certbot",
  "No NGINX config",
];

export function DnsDomains() {
  return (
    <section className="relative py-28 sm:py-36">
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* Header */}
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
            <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
              DNS &amp; domains
            </span>
          </div>
          <h2>
            <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
              Domains &amp; wildcards.
            </span>
            <span
              className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
              style={{ color: "var(--th-on-40)" }}
            >
              SSL included for all.
            </span>
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-[1.65] th-text-body">
            Connect any domain — including full <strong className="th-text-heading">wildcard subdomains</strong> like{" "}
            <code className="rounded-md border border-[var(--th-card-bd)] bg-[var(--th-sf-02)] px-1.5 py-0.5 font-mono text-[14px] th-text-heading">*.yoursite.com</code>.
            Certificates auto-provision and auto-renew. Three steps, zero config.
          </p>

          {/* Highlight pills */}
          <div className="mx-auto mt-5 flex flex-wrap justify-center gap-2">
            {HIGHLIGHTS.map((h) => (
              <span
                key={h}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--th-on-06)] bg-white/60 px-3 py-1 text-[12px] font-medium backdrop-blur-sm th-text-secondary"
              >
                <svg className="h-3 w-3" style={{ color: "var(--th-clr-sea)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                {h}
              </span>
            ))}
          </div>
        </div>

        {/* Steps — horizontal on desktop */}
        <div className="mx-auto mt-16 grid max-w-4xl gap-6 md:grid-cols-3">
          {STEPS.map((s) => (
            <div
              key={s.step}
              className="group relative rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-6 shadow-[var(--th-card-shadow)] transition-colors hover:border-[var(--th-card-bd-hover)]"
            >
              {/* Step number */}
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: "var(--th-clr-sea-bg)", color: "var(--th-clr-sea)" }}>
                {s.icon}
              </div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] th-text-muted">
                Step {s.step}
              </p>
              <h3 className="text-[16px] font-semibold th-text-heading">
                {s.title}
              </h3>
              <p className="mt-1.5 text-[13px] leading-[1.6] th-text-body">
                {s.desc}
              </p>
            </div>
          ))}
        </div>

        {/* Visual example DNS */}
        <div className="mx-auto mt-10 max-w-4xl overflow-hidden rounded-xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] font-mono text-[13px] shadow-[var(--th-card-shadow)]">
          <div className="flex items-center justify-between border-b border-[var(--th-card-bd)] px-5 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] th-text-muted">Your DNS provider</span>
            <span className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase" style={{ background: "var(--th-clr-sea-wash)", color: "var(--th-clr-sea)" }}>Wildcard ready</span>
          </div>
          <div className="divide-y divide-[var(--th-card-bd)]">
            <div className="grid grid-cols-[56px_1fr_1fr] items-center gap-4 px-5 py-3">
              <span className="font-semibold" style={{ color: "var(--th-clr-sea)" }}>A</span>
              <span className="th-text-heading">@</span>
              <span className="th-text-muted">→ 95.216.xx.xx</span>
            </div>
            <div className="grid grid-cols-[56px_1fr_1fr] items-center gap-4 px-5 py-3" style={{ background: "var(--th-sf-01)" }}>
              <span className="font-semibold" style={{ color: "var(--th-clr-sea)" }}>CNAME</span>
              <span className="th-text-heading">*</span>
              <span className="th-text-muted">→ proxy.openship.app</span>
            </div>
            <div className="grid grid-cols-[56px_1fr_1fr] items-center gap-4 px-5 py-3">
              <span className="font-semibold" style={{ color: "var(--th-clr-plum)" }}>TXT</span>
              <span className="th-text-heading">_acme-challenge</span>
              <span className="th-text-muted">→ auto-managed by Openship</span>
            </div>
          </div>
          <div className="border-t border-[var(--th-card-bd)] bg-[var(--th-sf-01)] px-5 py-2.5 text-[12px] th-text-muted">
            <svg className="mr-1.5 inline h-3.5 w-3.5" style={{ color: "var(--th-clr-sea)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
            </svg>
            Wildcard cert covers <strong className="th-text-heading">*.yoursite.com</strong> — every subdomain is HTTPS automatically
          </div>
        </div>
      </div>
    </section>
  );
}
