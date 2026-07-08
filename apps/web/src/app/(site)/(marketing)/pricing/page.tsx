"use client";

import { useState } from "react";
import { Navbar, Footer } from "@/components/landing";

/* ─── Plans ──────────────────────────────────────────────────── */

type Plan = {
  n: string;
  name: string;
  tag: string;
  price: { monthly: string; yearly: string };
  priceNote: string;
  lead: string;
  cta: string;
  ctaHref: string;
  features: string[];
  highlight?: boolean;
};

const PLANS: Plan[] = [
  {
    n: "01",
    name: "Hobby",
    tag: "Self-hosted",
    price: { monthly: "$0", yearly: "$0" },
    priceNote: "Forever, on your servers",
    lead: "Run the full platform on a server you own. No metering, no caps, no telemetry.",
    cta: "Read the source",
    ctaHref: "https://github.com/openship/openship",
    features: [
      "Full platform, open source (AGPL-3)",
      "Unlimited deploys, domains, projects",
      "All managed services - Postgres, Redis, mail",
      "CLI, web, desktop - same backend",
      "Community support",
    ],
  },
  {
    n: "02",
    name: "Cloud",
    tag: "Managed",
    price: { monthly: "$20", yearly: "$16" },
    priceNote: "Per seat, billed monthly",
    lead: "Openship Cloud - managed multi-region, auto-scaling, backups included.",
    cta: "Start free",
    ctaHref: "/login",
    features: [
      "Everything in Hobby",
      "Managed multi-region edge",
      "Auto-scaling and zero-downtime deploys",
      "Daily backups, point-in-time recovery",
      "Built-in mail server, unlimited domains",
      "Live monitoring and alerts",
      "Email support",
    ],
    highlight: true,
  },
  {
    n: "03",
    name: "Business",
    tag: "Hybrid",
    price: { monthly: "Custom", yearly: "Custom" },
    priceNote: "Per project, talk to us",
    lead: "Cloud + your servers, audit logs, SSO, contractual SLA. For teams shipping production.",
    cta: "Talk to sales",
    ctaHref: "/contact",
    features: [
      "Everything in Cloud",
      "Run apps on your VPS, services on the cloud",
      "SSO (SAML, OIDC) and SCIM provisioning",
      "Audit log retention and export",
      "99.9% uptime SLA",
      "Priority support, dedicated channel",
      "Compliance-ready (SOC 2 / ISO 27001)",
    ],
  },
];

/* ─── Feature matrix rows ────────────────────────────────────── */

type MatrixRow = { feature: string; hobby: string; cloud: string; business: string };

const MATRIX: { group: string; rows: MatrixRow[] }[] = [
  {
    group: "Deploy",
    rows: [
      { feature: "Projects",                 hobby: "Unlimited", cloud: "Unlimited", business: "Unlimited" },
      { feature: "Deploys per month",        hobby: "Unlimited", cloud: "Unlimited", business: "Unlimited" },
      { feature: "Preview deployments",      hobby: "Included",  cloud: "Included",  business: "Included" },
      { feature: "Rollbacks",                hobby: "Included",  cloud: "Included",  business: "Included" },
    ],
  },
  {
    group: "Run",
    rows: [
      { feature: "Auto-scaling",             hobby: "Manual",    cloud: "Automatic", business: "Automatic + policies" },
      { feature: "Multi-region",             hobby: "DIY",       cloud: "Built in",  business: "Built in" },
      { feature: "Zero-downtime deploys",    hobby: "Included",  cloud: "Included",  business: "Included" },
      { feature: "Uptime SLA",               hobby: "-",         cloud: "Best effort", business: "99.9% contractual" },
    ],
  },
  {
    group: "Services",
    rows: [
      { feature: "Postgres / Redis / Mongo", hobby: "Self-run",  cloud: "Managed",   business: "Managed" },
      { feature: "Mail server",              hobby: "Self-run",  cloud: "Included, unlimited domains", business: "Included, unlimited domains" },
      { feature: "Object storage (S3)",      hobby: "Self-run",  cloud: "Included",  business: "Included" },
      { feature: "Daily backups + PITR",     hobby: "DIY",       cloud: "Included",  business: "Included + extended retention" },
    ],
  },
  {
    group: "Team & Security",
    rows: [
      { feature: "Team members",             hobby: "Unlimited", cloud: "Per-seat",  business: "Per-seat" },
      { feature: "Roles & permissions",      hobby: "Owner only", cloud: "Owner, admin, deployer, viewer", business: "Custom roles" },
      { feature: "Audit log",                hobby: "-",         cloud: "30 days",   business: "12 months + export" },
      { feature: "SSO (SAML / OIDC)",        hobby: "-",         cloud: "-",         business: "Included" },
      { feature: "SCIM provisioning",        hobby: "-",         cloud: "-",         business: "Included" },
    ],
  },
  {
    group: "Support",
    rows: [
      { feature: "Channel",                  hobby: "Community", cloud: "Email",     business: "Priority email + Slack" },
      { feature: "Response time",            hobby: "Best effort", cloud: "1 business day", business: "4 business hours" },
      { feature: "Migration assistance",     hobby: "-",         cloud: "Self-serve", business: "Hands-on" },
    ],
  },
];

/* ─── FAQ ────────────────────────────────────────────────────── */

const FAQ = [
  {
    q: "Is there a free trial?",
    a: "Cloud is free to start - sign up, deploy, no credit card. You only enter billing once you exceed the free allowances on compute and bandwidth. Hobby is free forever on your own servers.",
  },
  {
    q: "How does the per-seat pricing work?",
    a: "Cloud is $20 per active team member per month, billed monthly, or $16 effective with annual billing. Projects, deploys, domains, and managed services are not metered per seat.",
  },
  {
    q: "Can I move between plans?",
    a: "Yes. Cloud ⇄ Hobby in one click - your containers travel as-is, no rebuild, no rewrites. Cloud ⇄ Business is a one-line config change.",
  },
  {
    q: "What counts as compute usage on Cloud?",
    a: "CPU-seconds and memory-seconds your running containers consume. Idle services that auto-scale to zero cost nothing. We bill in arrears with a clear monthly breakdown.",
  },
  {
    q: "Do you charge for bandwidth?",
    a: "Cloud includes 100 GB of egress per project per month. Overage is billed at $0.05 per GB, capped - and edge cache hits don't count.",
  },
  {
    q: "What's the license for Hobby?",
    a: "AGPL-3.0. The platform stays open for everyone who deploys with it, including anyone who forks it. You can run it in your cloud, on a Raspberry Pi, or in production for a SaaS - no commercial restrictions.",
  },
  {
    q: "Do you store my source code?",
    a: "Only what's needed to build. We never store unencrypted secrets, and source is fetched fresh from your repo for each build. Self-hosted keeps everything on your infrastructure by definition.",
  },
];

/* ─── Page ───────────────────────────────────────────────────── */

export default function PricingPage() {
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly");

  return (
    <>
      <Navbar />
      <main className="pp-root">

        {/* ── Hero ───────────────────────────────────────────── */}
        <section className="pp-hero">
          <div className="pp-hero-glow" aria-hidden="true" />
          <div className="pp-container pp-hero-inner">
            <p className="pp-eyebrow">Pricing</p>
            <h1 className="pp-headline">
              Free to run.<br />
              <span className="pp-headline-soft">Fair to scale.</span>
            </h1>
            <p className="pp-sub">
              The full platform is open source. The cloud is priced per seat,
              not per feature. Move between them whenever you want.
            </p>

            {/* Billing toggle */}
            <div className="pp-toggle" role="tablist" aria-label="Billing period">
              <button
                role="tab"
                aria-selected={period === "monthly"}
                onClick={() => setPeriod("monthly")}
                className={`pp-toggle-btn ${period === "monthly" ? "pp-toggle-btn--on" : ""}`}
              >
                Monthly
              </button>
              <button
                role="tab"
                aria-selected={period === "yearly"}
                onClick={() => setPeriod("yearly")}
                className={`pp-toggle-btn ${period === "yearly" ? "pp-toggle-btn--on" : ""}`}
              >
                Yearly
                <span className="pp-toggle-save">−20%</span>
              </button>
            </div>

            <ul className="pp-hero-trust">
              <li>No credit card</li>
              <li>Cancel anytime</li>
              <li>Open source · AGPL-3</li>
              <li>Migrate cloud ⇄ self-host any day</li>
            </ul>
          </div>
        </section>

        {/* ── Plan cards ─────────────────────────────────────── */}
        <section className="pp-plans-section">
          <div className="pp-container">
            <div className="pp-plans">
              {PLANS.map((p) => (
                <article
                  key={p.name}
                  className={`pp-plan ${p.highlight ? "pp-plan--highlight" : ""}`}
                >
                  {p.highlight && <span className="pp-plan-ribbon">Most popular</span>}

                  <div className="pp-plan-top">
                    <span className="pp-plan-n">{p.n}</span>
                    <span className="pp-plan-tag">{p.tag}</span>
                  </div>

                  <h2 className="pp-plan-name">{p.name}</h2>
                  <p className="pp-plan-lead">{p.lead}</p>

                  <div className="pp-plan-price">
                    <span className="pp-plan-amt">
                      {p.price[period]}
                      {p.price[period] !== "Custom" && p.price[period] !== "$0" && (
                        <span className="pp-plan-per">/ seat / month</span>
                      )}
                    </span>
                    <span className="pp-plan-pricenote">{p.priceNote}</span>
                  </div>

                  <a href={p.ctaHref} className={`pp-plan-cta ${p.highlight ? "pp-plan-cta--filled" : ""}`}>
                    {p.cta}
                  </a>

                  <ul className="pp-plan-features">
                    {p.features.map((f) => (
                      <li key={f}>
                        <svg className="pp-plan-check" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                          <path d="M4 10.5l4 4 8-10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ── Feature matrix ─────────────────────────────────── */}
        <section className="pp-matrix-section">
          <div className="pp-container">
            <header className="pp-matrix-head">
              <p className="pp-eyebrow">Compare everything</p>
              <h2 className="pp-matrix-title">
                The full feature matrix.
              </h2>
            </header>

            <div className="pp-matrix">
              <div className="pp-matrix-highlight" aria-hidden="true" />

              <div className="pp-matrix-row pp-matrix-row--head">
                <div className="pp-matrix-cell pp-matrix-cell--feat">Feature</div>
                <div className="pp-matrix-cell">Hobby</div>
                <div className="pp-matrix-cell pp-matrix-cell--win">Cloud</div>
                <div className="pp-matrix-cell">Business</div>
              </div>

              {MATRIX.map((g) => (
                <div key={g.group} className="pp-matrix-group">
                  <div className="pp-matrix-row pp-matrix-row--group">
                    <div className="pp-matrix-cell pp-matrix-cell--feat">
                      {g.group}
                    </div>
                    <div className="pp-matrix-cell" />
                    <div className="pp-matrix-cell pp-matrix-cell--win" />
                    <div className="pp-matrix-cell" />
                  </div>
                  {g.rows.map((r) => (
                    <div key={r.feature} className="pp-matrix-row">
                      <div className="pp-matrix-cell pp-matrix-cell--feat">{r.feature}</div>
                      <div className="pp-matrix-cell">{r.hobby}</div>
                      <div className="pp-matrix-cell pp-matrix-cell--win">{r.cloud}</div>
                      <div className="pp-matrix-cell">{r.business}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── FAQ ────────────────────────────────────────────── */}
        <section className="pp-faq-section">
          <div className="pp-container">
            <header className="pp-faq-head">
              <p className="pp-eyebrow">Questions</p>
              <h2 className="pp-faq-title">Answered.</h2>
            </header>

            <div className="pp-faq-list">
              {FAQ.map((f) => (
                <details key={f.q} className="pp-faq-item">
                  <summary className="pp-faq-q">
                    <span>{f.q}</span>
                    <span className="pp-faq-icon" aria-hidden="true">
                      <svg viewBox="0 0 16 16" fill="none">
                        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </summary>
                  <p className="pp-faq-a">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ── Final CTA ──────────────────────────────────────── */}
        <section className="pp-end">
          <div className="pp-container">
            <div className="pp-end-card">
              <h2 className="pp-end-title">Try it free, ship today.</h2>
              <p className="pp-end-sub">
                Sign up takes thirty seconds. No credit card required, no lock-in,
                no contracts.
              </p>
              <div className="pp-end-cta-row">
                <a href="/login" className="pp-btn pp-btn--primary">Start free</a>
                <a href="https://github.com/openship/openship" target="_blank" rel="noreferrer" className="pp-btn pp-btn--ghost">
                  Self-host on GitHub
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
