/* ── scaling paths ── */
const PATHS = [
  {
    tag: "Openship Cloud",
    tagColor: "var(--th-clr-plum)",
    tagBg: "var(--th-clr-plum-bg)",
    title: "Auto-scale. Zero config.",
    desc: "Deploy to Openship Cloud and scaling is handled for you — containers spin up automatically when traffic spikes and wind down when it drops. Manage it all from the CLI or dashboard. You never touch a load balancer.",
    features: [
      "Horizontal auto-scaling per service",
      "Built-in load balancing & app controls",
      "Zero-downtime rolling deploys",
      "Pay only for what you use",
    ],
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
      </svg>
    ),
    blob: "var(--th-clr-plum-blob)",
  },
  {
    tag: "Self-hosted",
    tagColor: "var(--th-clr-sea)",
    tagBg: "var(--th-clr-sea-bg)",
    title: "One tap. Bigger server.",
    desc: "Outgrew your VPS? Spin up a larger server and move everything with a single command. Data, configs, and domains carry over — nothing is lost, ever.",
    features: [
      "Export & import from the CLI or dashboard",
      "All data, certs & configs migrate",
      "Multi-node cluster when you're ready",
      "No re-deploy, no re-config",
    ],
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
      </svg>
    ),
    blob: "var(--th-clr-sea-blob)",
  },
];

const SCALE_STEPS = [
  {
    num: "1",
    title: "You grow",
    desc: "Traffic doubles, your team ships faster, services multiply.",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" />
      </svg>
    ),
  },
  {
    num: "2",
    title: "Upgrade the box",
    desc: "Buy a bigger VPS or add a second node — 60 seconds from the CLI.",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
      </svg>
    ),
  },
  {
    num: "3",
    title: "Move everything",
    desc: "One tap migrates data, certs, domains. Zero downtime.",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.58-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
      </svg>
    ),
  },
  {
    num: "4",
    title: "Nothing lost",
    desc: "Same projects, same domains, same certs. Just faster hardware.",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

const CHECK = (
  <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
  </svg>
);

export function Scaling() {
  return (
    <section className="relative py-28 sm:py-36">
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* ── Header ── */}
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
            <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
              Scaling
            </span>
          </div>
          <h2>
            <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
              Scale without fear.
            </span>
            <span
              className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
              style={{ color: "var(--th-on-40)" }}
            >
              Lose nothing.
            </span>
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-[1.65] th-text-body">
            Whether you auto-scale on Openship Cloud or upgrade your own VPS,
            scaling never means starting over. Your projects, domains, certs, and
            data move with you — manage it all from the CLI or dashboard.
          </p>
        </div>

        {/* ── Two scaling paths ── */}
        <div className="mx-auto mt-16 grid max-w-6xl gap-6 lg:grid-cols-2">
          {PATHS.map((p) => (
            <div
              key={p.tag}
              className="relative overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-7 shadow-[var(--th-card-shadow)] transition-colors hover:border-[var(--th-card-bd-hover)]"
            >
              {/* ambient blob */}
              <div
                className="pointer-events-none absolute -right-16 -top-16 h-[200px] w-[200px] rounded-full blur-[70px]"
                style={{ background: p.blob }}
              />

              <div className="relative">
                {/* Tag + icon */}
                <div className="mb-4 flex items-center gap-3">
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-xl"
                    style={{ background: p.tagBg, color: p.tagColor }}
                  >
                    {p.icon}
                  </div>
                  <span
                    className="rounded-full px-3 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em]"
                    style={{ background: p.tagBg, color: p.tagColor }}
                  >
                    {p.tag}
                  </span>
                </div>

                <h3 className="text-[22px] font-bold leading-tight tracking-tight th-text-heading">
                  {p.title}
                </h3>
                <p className="mt-2 text-[14px] leading-[1.65] th-text-body">
                  {p.desc}
                </p>

                <ul className="mt-5 space-y-2.5">
                  {p.features.map((f) => (
                    <li
                      key={f}
                      className="flex items-start gap-2.5 text-[14px] font-medium th-text-heading"
                    >
                      <span style={{ color: p.tagColor }}>{CHECK}</span>
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>

        {/* ── Self-host scale flow (horizontal steps) ── */}
        <div className="mx-auto mt-16 max-w-5xl">
          <p className="mb-6 text-center text-[13px] font-semibold uppercase tracking-[0.08em] th-text-muted">
            How self-host scaling works
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {SCALE_STEPS.map((s) => (
              <div
                key={s.num}
                className="group relative rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-5 shadow-[var(--th-card-shadow)] transition-colors hover:border-[var(--th-card-bd-hover)]"
              >
                <div
                  className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg"
                  style={{ background: "var(--th-clr-sea-bg)", color: "var(--th-clr-sea)" }}
                >
                  {s.icon}
                </div>
                <p className="mb-0.5 text-[11px] font-bold uppercase tracking-[0.1em] th-text-muted">
                  Step {s.num}
                </p>
                <h4 className="text-[15px] font-semibold th-text-heading">
                  {s.title}
                </h4>
                <p className="mt-1 text-[13px] leading-[1.55] th-text-body">
                  {s.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
