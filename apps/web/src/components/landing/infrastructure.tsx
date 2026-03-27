/* ── Included Infrastructure — merged CDN + Mail + DNS/SSL ── */

const INFRA_BLOCKS = [
  {
    badge: "Domains & SSL",
    title: "Wildcard domains. Auto SSL.",
    desc: "Connect any domain — apex, subdomain, or full wildcard. Certificates auto-provision and auto-renew via Let's Encrypt. No Certbot, no NGINX config.",
    color: "var(--th-clr-sea)",
    bg: "var(--th-clr-sea-bg)",
    items: [
      "Wildcard subdomains (*.yoursite.com)",
      "Unlimited custom domains",
      "Auto-renew SSL — zero maintenance",
      "Three steps: add domain, copy DNS, done",
    ],
  },
  {
    badge: "Global CDN",
    title: "Edge caching. Fast everywhere.",
    desc: "Every deploy is backed by a global edge network — automatic caching, HTTP/3, Brotli compression. Your self-hosted app loads as fast as any managed platform.",
    color: "var(--th-clr-plum)",
    bg: "var(--th-clr-plum-bg)",
    items: [
      "Automatic edge caching — no configuration",
      "HTTP/3 and Brotli compression out of the box",
      "Instant cache purge on every deploy",
      "Works with any VPS — no separate CDN subscription",
    ],
  },
  {
    badge: "Built-in Mail",
    title: "Free mail server. No Sendgrid.",
    desc: "Every instance includes a production-grade mail server with full authentication. Add as many domains as you want — no third-party service, no per-email bills.",
    color: "var(--th-clr-terra)",
    bg: "var(--th-clr-terra-bg)",
    items: [
      "Unlimited domains with dedicated inboxes",
      "DKIM, SPF & DMARC out of the box",
      "One-click setup — DNS auto-configured",
      "Zero monthly cost",
    ],
  },
];

const CHECK = (
  <svg
    className="mt-0.5 h-3.5 w-3.5 shrink-0"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2.5}
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
  </svg>
);

export function Infrastructure() {
  return (
    <section className="relative py-28 sm:py-36">
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* Header */}
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
            <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
              Included
            </span>
          </div>
          <h2>
            <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
              Everything you&apos;d pay extra for.
            </span>
            <span
              className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
              style={{ color: "var(--th-on-40)" }}
            >
              Built in.
            </span>
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-[1.65] th-text-body">
            SSL, CDN, mail server — things that usually cost extra or require separate
            services. Openship includes them all, configured automatically.
          </p>
        </div>

        {/* Three-column grid */}
        <div className="mx-auto mt-16 grid max-w-6xl gap-5 lg:grid-cols-3">
          {INFRA_BLOCKS.map((block) => (
            <div
              key={block.badge}
              className="group relative overflow-hidden rounded-2xl border border-[var(--th-card-bd)] bg-[var(--th-card-bg)] p-7 shadow-[var(--th-card-shadow)] transition-colors hover:border-[var(--th-card-bd-hover)]"
            >
              {/* Badge */}
              <span
                className="inline-flex rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em]"
                style={{ background: block.bg, color: block.color }}
              >
                {block.badge}
              </span>

              {/* Title & desc */}
              <h3 className="mt-4 text-[18px] font-semibold leading-snug th-text-heading">
                {block.title}
              </h3>
              <p className="mt-2 text-[14px] leading-[1.6] th-text-body">
                {block.desc}
              </p>

              {/* Checklist */}
              <ul className="mt-5 space-y-2.5">
                {block.items.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-2 text-[13px] th-text-heading"
                  >
                    <span style={{ color: block.color }}>{CHECK}</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
