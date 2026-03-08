const PERKS = [
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
      </svg>
    ),
    title: "Unlimited domains",
    desc: "Add as many custom domains as you need — every one gets its own inbox.",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
      </svg>
    ),
    title: "DKIM, SPF & DMARC",
    desc: "Full authentication out of the box so your emails land in inboxes, not spam.",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
      </svg>
    ),
    title: "Zero monthly cost",
    desc: "No Sendgrid, no Resend, no per-email bills. Your server, your mail.",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
    title: "One-click setup",
    desc: "Connect a domain, DNS records are auto-configured — mail just works.",
  },
];

export function MailServer() {
  return (
    <section className="relative py-28 sm:py-36">
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* Header */}
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
            <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
              Built-in mail
            </span>
          </div>
          <h2>
            <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
              Free mail server.
            </span>
            <span
              className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
              style={{ color: "var(--th-on-40)" }}
            >
              Unlimited domains.
            </span>
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-[16px] leading-[1.65] th-text-body">
            Stop paying per email. Every Openship instance includes a
            production-grade mail server — add as many domains as you want, no
            third-party service required.
          </p>
        </div>

        {/* Perks grid */}
        <div className="mx-auto mt-16 grid max-w-5xl gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {PERKS.map((p) => (
            <div
              key={p.title}
              className="relative overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-6 shadow-[var(--th-card-shadow)] transition-colors hover:border-[var(--th-card-bd-hover)]"
            >
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: "var(--th-clr-plum-bg)", color: "var(--th-clr-plum)" }}>
                {p.icon}
              </div>
              <h3 className="text-[15px] font-semibold th-text-heading">
                {p.title}
              </h3>
              <p className="mt-1.5 text-[13px] leading-[1.6] th-text-body">
                {p.desc}
              </p>
            </div>
          ))}
        </div>

        {/* Visual: example DNS records */}
        <div className="mx-auto mt-12 max-w-3xl overflow-hidden rounded-xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] font-mono text-[13px] shadow-[var(--th-card-shadow)]">
          <div className="border-b border-[var(--th-card-bd)] px-5 py-2.5 text-[11px] uppercase tracking-[0.1em] th-text-muted">
            Auto-configured DNS records
          </div>
          <div className="space-y-px">
            {[
              { type: "MX", name: "mail.example.com", value: "10 mx.openship.app" },
              { type: "TXT", name: "example.com", value: "v=spf1 include:openship.app ~all" },
              { type: "TXT", name: "_dmarc.example.com", value: "v=DMARC1; p=quarantine;" },
              { type: "CNAME", name: "dkim._domainkey", value: "dkim.openship.app" },
            ].map((r, i) => (
              <div
                key={i}
                className="grid grid-cols-[56px_1fr_1fr] gap-4 px-5 py-2"
                style={{
                  background:
                    i % 2 === 0 ? "transparent" : "rgba(0,0,0,.015)",
                }}
              >
                <span style={{ color: "var(--th-clr-plum)" }}>{r.type}</span>
                <span className="th-text-heading">{r.name}</span>
                <span className="th-text-muted truncate">{r.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
