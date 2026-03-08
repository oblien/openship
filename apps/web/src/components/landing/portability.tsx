const DIRECTIONS = [
  {
    from: "Self-hosted VPS",
    to: "Openship Cloud",
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
      </svg>
    ),
    desc: "Want managed scaling? Push your self-hosted instance to Openship Cloud — projects, domains, certs, and databases transfer instantly. Control everything from the app.",
    color: "var(--th-clr-plum)",
    bgWash: "var(--th-clr-plum-bg)",
    blob: "var(--th-clr-plum-blob)",
  },
  {
    from: "Openship Cloud",
    to: "Self-hosted VPS",
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
      </svg>
    ),
    desc: "Want full control? Export from Openship Cloud to your own server in one tap. You own the data — we never hold it hostage.",
    color: "var(--th-clr-sea)",
    bgWash: "var(--th-clr-sea-bg)",
    blob: "var(--th-clr-sea-blob)",
  },
  {
    from: "Server A",
    to: "Server B",
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
      </svg>
    ),
    desc: "Moving between VPS providers? Hetzner to DigitalOcean, OVH to Hostinger — migrate everything without touching a config file.",
    color: "var(--th-clr-terra)",
    bgWash: "var(--th-clr-terra-bg)",
    blob: "var(--th-clr-terra-blob)",
  },
];

const TRUST_POINTS = [
  "No proprietary formats — standard Docker + volumes",
  "CLI export produces a portable .tar.gz archive",
  "Encrypted transfer over SSH by default",
  "Domains & SSL auto-reconnect on the new host",
  "Works between any Linux server, any provider",
];

const CHECK = (
  <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
  </svg>
);

export function Portability() {
  return (
    <section className="relative py-28 sm:py-36">
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* ── Header ── */}
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
            <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
              Portability
            </span>
          </div>
          <h2>
            <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
              Cloud ↔ self-host.
            </span>
            <span
              className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
              style={{ color: "var(--th-on-40)" }}
            >
              Move anytime. Zero setup.
            </span>
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-[1.65] th-text-body">
            Your infrastructure should never be a cage. Transfer between Openship
            Cloud and any self-hosted VPS — or between two servers — in a single
            tap from the app. No re-deploy, no data loss, no vendor games.
          </p>
        </div>

        {/* ── Direction cards ── */}
        <div className="mx-auto mt-16 grid max-w-6xl gap-6 md:grid-cols-3">
          {DIRECTIONS.map((d) => (
            <div
              key={d.from + d.to}
              className="relative overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-7 shadow-[var(--th-card-shadow)] transition-colors hover:border-[var(--th-card-bd-hover)]"
            >
              {/* Accent top bar */}
              <div
                className="absolute inset-x-0 top-0 h-[3px]"
                style={{ background: d.color }}
              />

              {/* Ambient blob */}
              <div
                className="pointer-events-none absolute -right-10 -top-10 h-[160px] w-[160px] rounded-full blur-[60px]"
                style={{ background: d.blob }}
              />

              <div className="relative">
                <div
                  className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl"
                  style={{ background: d.bgWash, color: d.color }}
                >
                  {d.icon}
                </div>

                {/* From → To — bigger & bolder */}
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="text-[17px] font-bold th-text-heading">{d.from}</span>
                  <svg className="h-4 w-4 th-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                  <span className="text-[17px] font-bold th-text-heading">{d.to}</span>
                </div>

                <p className="text-[14px] leading-[1.65] th-text-body">{d.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* ── CLI demo + trust points ── */}
        <div className="mx-auto mt-14 grid max-w-5xl items-start gap-10 lg:grid-cols-[1fr_1fr]">
          {/* Terminal card */}
          <div className="overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] font-mono text-[13px] shadow-[var(--th-card-shadow)]">
            <div className="border-b border-[var(--th-card-bd)] px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] th-text-muted">
              Terminal
            </div>
            <div className="space-y-2 px-5 py-4">
              <div>
                <span className="th-text-muted">$</span>{" "}
                <span className="th-text-heading">openship export</span>
              </div>
              <div className="th-text-muted">
                ✓ 3 projects, 2 databases, 4 domains
              </div>
              <div className="th-text-muted">
                ✓ Packed → openship-backup-2026-03-07.tar.gz (142 MB)
              </div>
              <div className="mt-3">
                <span className="th-text-muted">$</span>{" "}
                <span className="th-text-heading">openship import --host new-server.example.com</span>
              </div>
              <div className="th-text-muted">
                ✓ Transferred via SSH (encrypted)
              </div>
              <div className="th-text-muted">
                ✓ Projects restored, domains reconnected
              </div>
              <div style={{ color: "var(--th-clr-sea)" }}>
                ✓ Migration complete — 0 downtime
              </div>
            </div>
          </div>

          {/* Trust points */}
          <div>
            <h3 className="mb-5 text-[20px] font-bold th-text-heading">
              True portability, not marketing talk.
            </h3>
            <ul className="space-y-3">
              {TRUST_POINTS.map((t) => (
                <li
                  key={t}
                  className="flex items-start gap-2.5 text-[15px] th-text-heading"
                >
                  <span style={{ color: "var(--th-clr-sea)" }}>{CHECK}</span>
                  {t}
                </li>
              ))}
            </ul>
            <p className="mt-6 text-[14px] leading-[1.65] th-text-body">
              Your stack is standard Docker. There is no proprietary runtime, no
              secret sauce tying you down. Leave whenever you want — or never
              leave at all. It&apos;s your call.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
