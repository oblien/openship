import { Navbar, Footer } from "@/components/landing";

/* ─── Plans ──────────────────────────────────────────────────── */

type Plan = {
  n: string;
  name: string;
  tag: string;
  price: string;
  priceNote: string;
  lead: string;
  cta: string;
  ctaHref: string;
  features: string[];
  highlight?: boolean;
  ribbon?: string;
};

const PLANS: Plan[] = [
  {
    n: "01",
    name: "Self-hosted",
    tag: "Open source",
    price: "Free",
    priceNote: "Apache 2.0 — free forever, no credit card",
    lead: "Run the whole platform on machines you own. Any Linux box, any provider, any region. No metering, no seat caps, no telemetry.",
    cta: "Start self-hosting",
    ctaHref: "/docs/getting-started/quickstart",
    ribbon: "Available now",
    features: [
      "Full platform, open source (Apache 2.0)",
      "Unlimited deploys, domains, projects",
      "All managed services — Postgres, Redis, mail",
      "CLI, web, desktop — same backend",
      "Community support",
    ],
  },
  {
    n: "02",
    name: "Openship Cloud",
    tag: "Managed",
    price: "Coming soon",
    priceNote: "Pricing announced before launch",
    lead: "Fully managed Openship — multi-region, auto-scaling, backups included. We're finishing payments setup; leave your email and you'll hear first.",
    cta: "Get notified",
    ctaHref: "/contact",
    ribbon: "Coming soon",
    features: [
      "Everything in self-hosted",
      "Managed multi-region edge",
      "Auto-scaling and zero-downtime deploys",
      "Daily backups, point-in-time recovery",
      "Built-in mail server, unlimited domains",
      "Live monitoring and alerts",
    ],
    highlight: true,
  },
];

/* ─── FAQ ────────────────────────────────────────────────────── */

const FAQ = [
  {
    q: "Is self-hosting really free?",
    a: "Yes — free forever. Run the full platform on your own servers with no metering, no seat caps, and no telemetry. It's open source under Apache 2.0, and there's nothing to buy or sign up for: install the CLI, point it at a box, and you're running.",
  },
  {
    q: "How much does Openship Cloud cost?",
    a: "Cloud pricing hasn't been announced yet — we're still finalizing it, along with payments. Leave your email on the contact page and we'll let you know before it launches. This only affects Cloud; self-hosting is available today.",
  },
  {
    q: "Can I move between self-hosted and cloud later?",
    a: "That's the goal — your containers travel as-is, no rebuild, no rewrites. Once Cloud launches, moving between it and self-hosting will be a one-click change.",
  },
  {
    q: "What's the license?",
    a: "Apache 2.0 — a permissive license. Use it, modify it, fork it, and ship it in commercial or closed-source products, no strings attached. Run it in your cloud, on a Raspberry Pi, or in production for a SaaS.",
  },
  {
    q: "Do you store my source code?",
    a: "Only what's needed to build. We never store unencrypted secrets, and source is fetched fresh from your repo for each build. Self-hosted keeps everything on your infrastructure by definition.",
  },
];

/* ─── Page ───────────────────────────────────────────────────── */

export default function PricingPage() {
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
              Free to self-host.<br />
              <span className="pp-headline-soft">Forever, on your own servers.</span>
            </h1>
            <p className="pp-sub">
              Openship is open source under Apache 2.0 — run the whole platform
              on any Linux box today, with no metering, no seat caps, and no
              credit card. Fully managed Openship Cloud is coming soon.
            </p>

            <ul className="pp-hero-trust">
              <li>Open source · Apache 2.0</li>
              <li>Free forever, self-hosted</li>
              <li>No lock-in</li>
              <li>Cloud coming soon</li>
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
                  {p.ribbon && (
                    <span className={`pp-plan-ribbon ${p.highlight ? "" : "pp-plan-ribbon--muted"}`}>
                      {p.ribbon}
                    </span>
                  )}

                  <div className="pp-plan-top">
                    <span className="pp-plan-n">{p.n}</span>
                    <span className="pp-plan-tag">{p.tag}</span>
                  </div>

                  <h2 className="pp-plan-name">{p.name}</h2>
                  <p className="pp-plan-lead">{p.lead}</p>

                  <div className="pp-plan-price">
                    <span className="pp-plan-amt">{p.price}</span>
                    <span className="pp-plan-pricenote">{p.priceNote}</span>
                  </div>

                  <a
                    href={p.ctaHref}
                    className={`pp-plan-cta ${p.highlight ? "pp-plan-cta--filled" : ""}`}
                  >
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
              <h2 className="pp-end-title">Start today, or wait for Cloud.</h2>
              <p className="pp-end-sub">
                Self-hosting is free and available right now — one command on any
                Linux box. If you'd rather we ran it for you, leave your email and
                we'll tell you the moment Openship Cloud opens.
              </p>
              <div className="pp-end-cta-row">
                <a href="/docs/getting-started/quickstart" className="pp-btn pp-btn--primary">
                  Start self-hosting
                </a>
                <a href="/contact" className="pp-btn pp-btn--ghost">
                  Get notified about Cloud
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
