const CHECK = (
  <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
  </svg>
);

const TIERS = [
  {
    name: "Free",
    price: "$0",
    period: "/month",
    description: "For side-projects and personal apps. Free forever.",
    cta: "Start Free",
    ctaHref: "/login",
    ctaStyle: "ghost" as const,
    featured: false,
    features: [
      "3 projects",
      "Unlimited deployments",
      "Wildcard SSL",
      "Built-in mail server",
      "CLI & REST API",
      "Git-push deploys",
      "Community support",
    ],
  },
  {
    name: "Pro",
    price: "$19",
    period: "/month",
    description: "For growing teams that need more power and priority support.",
    cta: "Start Pro",
    ctaHref: "/login",
    ctaStyle: "ghost" as const,
    featured: false,
    features: [
      "Unlimited projects",
      "Custom domains",
      "Preview deployments",
      "Team collaboration (5 seats)",
      "Advanced analytics",
      "MCP integration",
      "Email support",
    ],
  },
  {
    name: "Scale",
    badge: "Most Popular",
    price: "$79",
    period: "/month",
    description: "For production workloads. Auto-scaling, SLA, and zero-downtime.",
    cta: "Start Scale",
    ctaHref: "/login",
    ctaStyle: "primary" as const,
    featured: true,
    features: [
      "Everything in Pro",
      "Auto-scaling",
      "99.9% uptime SLA",
      "Zero-downtime deploys",
      "Built-in CDN & edge caching",
      "Unlimited team seats",
      "Priority support",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "Dedicated infrastructure, compliance, and SLA guarantees.",
    cta: "Contact Sales",
    ctaHref: "mailto:sales@openship.dev",
    ctaStyle: "ghost" as const,
    featured: false,
    features: [
      "Everything in Scale",
      "Dedicated infrastructure",
      "SSO & SAML",
      "Custom SLAs",
      "Audit logs & SOC 2",
      "On-premise option",
      "Dedicated support channel",
    ],
  },
];

export function Pricing() {
  return (
    <section className="relative py-28 sm:py-36">
      {/* Divider */}
      <div className="section-divider mx-auto mb-28 max-w-4xl sm:mb-36" />

      <div className="mx-auto max-w-7xl px-6">
        {/* Header */}
        <div className="mx-auto max-w-2xl text-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--th-on-06)] bg-white/60 px-4 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,.04)] backdrop-blur-sm">
            <span className="text-[12px] font-medium tracking-[0.02em] th-text-secondary">
              Transparent pricing
            </span>
          </div>
          <h2>
            <span className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em] th-text-heading">
              Start free.
            </span>
            <span
              className="block text-[clamp(2.75rem,6vw,4.75rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
              style={{ color: "var(--th-on-40)" }}
            >
              Scale when ready.
            </span>
          </h2>
          <p className="mt-6 text-[16px] leading-[1.65] th-text-body">
            Start free with 3 projects. Upgrade when you need more power. No surprise
            bills, no usage caps.
          </p>
        </div>

        {/* Cards */}
        <div className="mx-auto mt-16 grid max-w-6xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className="relative flex flex-col rounded-2xl"
              style={
                tier.featured
                  ? {
                      background: "rgba(0,0,0,.92)",
                      boxShadow:
                        "0 24px 64px rgba(0,0,0,.15), 0 2px 8px rgba(0,0,0,.08)",
                    }
                  : {
                      background: "var(--th-card-bg)",
                      border: "1px solid var(--th-card-bd)",
                      boxShadow: "var(--th-card-shadow)",
                    }
              }
            >
              {tier.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="rounded-full bg-[var(--th-accent-violet)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-white whitespace-nowrap">
                    {tier.badge}
                  </span>
                </div>
              )}

              <div className="p-6 pb-5">
                {/* Tier name */}
                <p
                  className="text-[13px] font-semibold uppercase tracking-[0.1em]"
                  style={{
                    color: tier.featured
                      ? "rgba(255,255,255,.45)"
                      : "var(--th-text-muted)",
                  }}
                >
                  {tier.name}
                </p>

                {/* Price */}
                <div className="mt-4 flex items-baseline gap-1">
                  <span
                    className="text-[2.75rem] font-semibold leading-none tracking-[-0.03em]"
                    style={{
                      color: tier.featured ? "#fff" : "var(--th-text-heading)",
                    }}
                  >
                    {tier.price}
                  </span>
                  {tier.period && (
                    <span
                      className="text-[14px]"
                      style={{
                        color: tier.featured
                          ? "rgba(255,255,255,.4)"
                          : "var(--th-text-muted)",
                      }}
                    >
                      {tier.period}
                    </span>
                  )}
                </div>

                {/* Description */}
                <p
                  className="mt-3 text-[14px] leading-[1.6]"
                  style={{
                    color: tier.featured
                      ? "rgba(255,255,255,.55)"
                      : "var(--th-text-body)",
                  }}
                >
                  {tier.description}
                </p>

                {/* CTA */}
                <a
                  href={tier.ctaHref}
                  target={
                    tier.ctaHref.startsWith("http") ? "_blank" : undefined
                  }
                  rel={
                    tier.ctaHref.startsWith("http")
                      ? "noopener noreferrer"
                      : undefined
                  }
                  className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-full px-5 py-2.5 text-[14px] font-medium transition-all"
                  style={
                    tier.featured
                      ? { background: "#fff", color: "rgba(0,0,0,.88)" }
                      : {
                          border: "1px solid var(--th-btn-ghost-bd)",
                          color: "var(--th-btn-ghost-text)",
                          background: "transparent",
                        }
                  }
                >
                  {tier.cta}
                </a>
              </div>

              {/* Divider */}
              <div
                className="mx-6 h-px"
                style={{
                  background: tier.featured
                    ? "rgba(255,255,255,.08)"
                    : "var(--th-card-bd)",
                }}
              />

              {/* Features */}
              <div className="flex flex-1 flex-col gap-2.5 p-6 pt-5">
                {tier.features.map((f) => (
                  <div key={f} className="flex items-center gap-2.5">
                    <span
                      style={{
                        color: tier.featured
                          ? "rgba(255,255,255,.5)"
                          : "var(--th-text-muted)",
                      }}
                    >
                      {CHECK}
                    </span>
                    <span
                      className="text-[13px]"
                      style={{
                        color: tier.featured
                          ? "rgba(255,255,255,.7)"
                          : "var(--th-text-body)",
                      }}
                    >
                      {f}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
