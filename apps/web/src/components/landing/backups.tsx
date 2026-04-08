const FEATURES = [
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    title: "Scheduled snapshots",
    desc: "Automatic daily backups of every project, database, and config. Keep the last 7, 14, or 30 — your choice.",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
      </svg>
    ),
    title: "One-click restore",
    desc: "Roll back to any snapshot instantly. Databases, environments, and deploy configs — everything comes back together.",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
      </svg>
    ),
    title: "Database dumps included",
    desc: "Postgres, MySQL, Redis — all backed up automatically alongside your application volumes. No extra config.",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 8.25H7.5a2.25 2.25 0 00-2.25 2.25v9a2.25 2.25 0 002.25 2.25h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25H15M9 12l3 3m0 0l3-3m-3 3V2.25" />
      </svg>
    ),
    title: "Download anytime",
    desc: "Export a full backup archive you can store anywhere — S3, your NAS, or a second VPS for disaster recovery.",
  },
];

export function Backups() {
  return (
    <section className="relative py-28 sm:py-36">
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* ── Header ── */}
        <div className="grid items-start gap-16 lg:grid-cols-2">
          {/* Left — text */}
          <div>
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
              <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
                Backups
              </span>
            </div>
            <h2>
              <span className="block text-[clamp(2.25rem,5vw,3.75rem)] font-semibold leading-[1.08] tracking-[-0.035em] th-text-heading">
                Built-in backups.
              </span>
              <span
                className="block text-[clamp(2.25rem,5vw,3.75rem)] font-semibold leading-[1.08] tracking-[-0.035em]"
                style={{ color: "var(--th-on-40)" }}
              >
                Set it and forget it.
              </span>
            </h2>
            <p className="mt-6 max-w-md text-[16px] leading-[1.65] th-text-body">
              Openship ships with automatic scheduled backups — projects,
              databases, volumes, SSL certs. Restore with one tap or download
              the archive for off-site storage.
            </p>
          </div>

          {/* Right — visual terminal */}
          <div className="overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] shadow-[var(--th-card-shadow)]">
            <div className="border-b border-[var(--th-card-bd)] px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] th-text-muted">
              Backup schedule
            </div>
            <div className="space-y-px font-mono text-[13px]">
              {[
                { time: "03:00 UTC", status: "completed", size: "142 MB", label: "Daily — Mar 7" },
                { time: "03:00 UTC", status: "completed", size: "138 MB", label: "Daily — Mar 6" },
                { time: "03:00 UTC", status: "completed", size: "135 MB", label: "Daily — Mar 5" },
                { time: "00:00 UTC", status: "completed", size: "412 MB", label: "Weekly — Mar 2" },
              ].map((b, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_auto_auto] gap-4 px-5 py-2.5"
                  style={{
                    background: i % 2 === 0 ? "transparent" : "rgba(0,0,0,.015)",
                  }}
                >
                  <div>
                    <span className="th-text-heading">{b.label}</span>
                    <span className="ml-2 th-text-muted">{b.time}</span>
                  </div>
                  <span className="th-text-muted">{b.size}</span>
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    style={{ background: "var(--th-clr-sea-bg)", color: "var(--th-clr-sea)" }}
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                    {b.status}
                  </span>
                </div>
              ))}
            </div>
            <div className="border-t border-[var(--th-card-bd)] px-5 py-3 text-right">
              <span className="cursor-default rounded-full border border-[var(--th-card-bd)] px-4 py-1.5 text-[12px] font-medium th-text-heading transition-colors hover:border-[var(--th-card-bd-hover)]">
                Restore latest →
              </span>
            </div>
          </div>
        </div>

        {/* ── Feature cards ── */}
        <div className="mx-auto mt-14 grid max-w-5xl gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-6 shadow-[var(--th-card-shadow)] transition-colors hover:border-[var(--th-card-bd-hover)]"
            >
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: "var(--th-clr-terra-bg)", color: "var(--th-clr-terra)" }}>
                {f.icon}
              </div>
              <h3 className="text-[15px] font-semibold th-text-heading">
                {f.title}
              </h3>
              <p className="mt-1.5 text-[13px] leading-[1.6] th-text-body">
                {f.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
