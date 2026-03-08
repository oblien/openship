/* ── comparison rows ── */
const ROWS: { feature: string; openship: string; vercel: string; warn?: boolean }[] = [
  { feature: "Unlimited deployments", openship: "Included", vercel: "$20 / seat / mo", warn: true },
  { feature: "CPU execution time", openship: "Your full server", vercel: "Metered — bills spike", warn: true },
  { feature: "Bandwidth", openship: "Unlimited", vercel: "100 GB then overage", warn: true },
  { feature: "Serverless invocations", openship: "No limits", vercel: "Billed per million", warn: true },
  { feature: "Wildcard SSL", openship: "Auto", vercel: "Enterprise only" },
  { feature: "Built-in mail server", openship: "Free", vercel: "—" },
  { feature: "Microservices / Docker", openship: "Native", vercel: "—" },
  { feature: "Custom backend & DB", openship: "Full control", vercel: "External only" },
  { feature: "Full-control app", openship: "Built-in", vercel: "Limited" },
  { feature: "MCP agent support", openship: "Built-in", vercel: "—" },
  { feature: "Self-host anywhere", openship: "Any VPS", vercel: "—" },
  { feature: "Vendor lock-in", openship: "None — MIT", vercel: "High" },
];

/* ── VPS providers ── */
const VPS = [
  { name: "Hetzner", from: "€3.79", note: "CX22 · 2 vCPU · 4 GB", accent: "#E32E2E" },
  { name: "Hostinger", from: "$5.99", note: "KVM 1 · 4 GB · 50 GB NVMe", accent: "#6746C8" },
  { name: "DigitalOcean", from: "$6.00", note: "Basic · 1 vCPU · 1 GB", accent: "#0080FF" },
  { name: "OVH", from: "€3.50", note: "Starter · 2 GB · ∞ traffic", accent: "#123F6D" },
];

/* ── vercel bill callout figures ── */
const BILLS = [
  { label: "Small SaaS", vercel: "$150+/mo", self: "~$8/mo" },
  { label: "Growing startup", vercel: "$800+/mo", self: "~$24/mo" },
  { label: "At scale", vercel: "$5,000+/mo", self: "~$80/mo" },
];

export function NoLockin() {
  return (
    <section className="relative py-28 sm:py-36">
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* ── Header ── */}
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
            <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
              Why switch
            </span>
          </div>
          <h2>
            <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
              Stop getting locked in.
            </span>
            <span
              className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
              style={{ color: "var(--th-on-40)" }}
            >
              Own your stack.
            </span>
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-[1.65] th-text-body">
            Vercel&apos;s metered CPU time, per-seat pricing, and bandwidth caps
            mean bills grow fast — especially when traffic spikes. With Openship,
            the app runs on <strong className="th-text-heading">your machine</strong> and deploys to
            <strong className="th-text-heading"> your server</strong> — you keep 100% of the performance you pay for.
          </p>
        </div>

        {/* ── Bill comparison callout ── */}
        <div className="mx-auto mt-14 grid max-w-5xl gap-4 sm:grid-cols-3">
          {BILLS.map((b) => (
            <div
              key={b.label}
              className="relative overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] px-6 py-5 shadow-[var(--th-card-shadow)]"
            >
              <p className="text-[12px] font-semibold uppercase tracking-[0.1em] th-text-muted">
                {b.label}
              </p>

              {/* Vercel row */}
              <div className="mt-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.06em] th-text-muted">Vercel</p>
                <p
                  className="mt-0.5 text-[clamp(1.25rem,2.5vw,1.625rem)] font-bold leading-none tracking-tight"
                  style={{ color: "var(--th-clr-terra)" }}
                >
                  {b.vercel}
                </p>
              </div>

              {/* Divider + arrow */}
              <div className="my-3 flex items-center gap-2">
                <div className="h-px flex-1" style={{ background: "var(--th-sf-06, rgba(0,0,0,.06))" }} />
                <svg className="h-4 w-4 shrink-0 th-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
                </svg>
                <div className="h-px flex-1" style={{ background: "var(--th-sf-06, rgba(0,0,0,.06))" }} />
              </div>

              {/* Self-host row */}
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.06em] th-text-muted">Self-host</p>
                <p
                  className="mt-0.5 text-[clamp(1.25rem,2.5vw,1.625rem)] font-bold leading-none tracking-tight"
                  style={{ color: "var(--th-clr-sea)" }}
                >
                  {b.self}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* ── Comparison table ── */}
        <div className="mx-auto mt-14 max-w-5xl overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] shadow-[var(--th-card-shadow)]">
          {/* Header row */}
          <div className="grid grid-cols-[1fr_140px_160px] sm:grid-cols-[1fr_200px_220px] border-b-2 border-[var(--th-card-bd)] bg-[var(--th-sf-02)] px-6 py-4">
            <span className="text-[13px] font-bold uppercase tracking-[0.08em] th-text-muted">
              Feature
            </span>
            <span className="text-center text-[14px] font-bold th-text-heading">
              🚀 Openship
            </span>
            <span className="text-center text-[14px] font-bold th-text-muted">
              Vercel
            </span>
          </div>

          {/* Data rows */}
          {ROWS.map((r, i) => (
            <div
              key={r.feature}
              className="grid grid-cols-[1fr_140px_160px] sm:grid-cols-[1fr_200px_220px] items-center border-t border-[var(--th-card-bd)] px-6 py-4"
              style={{ background: i % 2 === 0 ? "transparent" : "var(--th-sf-01)" }}
            >
              <span className="text-[15px] font-medium th-text-heading">
                {r.feature}
              </span>
              <span className="text-center">
                <span
                  className="inline-block rounded-full px-3.5 py-1 text-[13px] font-semibold"
                  style={{ background: "var(--th-clr-sea-wash)", color: "var(--th-clr-sea)" }}
                >
                  {r.openship}
                </span>
              </span>
              <span className="text-center">
                <span
                  className="inline-block rounded-full px-3.5 py-1 text-[13px] font-medium"
                  style={{
                    background: r.warn ? "var(--th-clr-terra-wash)" : "var(--th-sf-04)",
                    color: r.warn ? "var(--th-clr-terra)" : "var(--th-text-secondary)",
                  }}
                >
                  {r.vercel}
                </span>
              </span>
            </div>
          ))}
        </div>

        {/* ── VPS provider cards ── */}
        <div className="mt-12">
          <p className="mb-5 text-center text-[13px] font-semibold uppercase tracking-[0.08em] th-text-muted">
            Self-host on any VPS — popular picks
          </p>
          <div className="mx-auto grid max-w-4xl grid-cols-2 gap-4 sm:grid-cols-4">
            {VPS.map((v) => (
              <div
                key={v.name}
                className="relative overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-5 shadow-[var(--th-card-shadow)] transition-colors hover:border-[var(--th-card-bd-hover)]"
              >
                <div
                  className="absolute inset-x-0 top-0 h-[3px]"
                  style={{ background: v.accent }}
                />
                <p className="text-[15px] font-bold th-text-heading">{v.name}</p>
                <p className="mt-1 text-[24px] font-bold tracking-tight th-text-heading">
                  {v.from}
                  <span className="ml-1 text-[13px] font-normal th-text-muted">/mo</span>
                </p>
                <p className="mt-1.5 text-[12px] leading-snug th-text-muted">{v.note}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
