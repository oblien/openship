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
  external?: boolean;
  features: string[];
  highlight?: boolean;
  ribbon?: string;
  ribbonMuted?: boolean;
  muted?: boolean;
};

const PLANS: Plan[] = [
  {
    n: "01",
    name: "Self-hosted",
    tag: "Unavailable",
    price: "Unavailable",
    priceNote: "Paused while we finish setting up payments",
    lead: "The self-hosted plan is temporarily unavailable while we sort out billing. It'll be back shortly — leave your email and we'll tell you the moment it opens.",
    cta: "Notify me",
    ctaHref: "/contact",
    ribbon: "Unavailable",
    ribbonMuted: true,
    muted: true,
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
    priceNote: "Plans announced once billing is live",
    lead: "Fully managed Openship — multi-region, auto-scaling, backups included. Plans open as soon as payments are ready.",
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
    q: "Why are the plans unavailable right now?",
    a: "We're finishing setting up payments and billing. Rather than show plans we can't complete sign-up for yet, we've paused them for the moment. It's temporary — leave your email on the contact page and we'll tell you the instant they open.",
  },
  {
    q: "How much does Openship Cloud cost?",
    a: "Cloud pricing hasn't been announced yet, and sign-ups are paused while we finish billing setup. Leave your email on the contact page and we'll let you know before it launches.",
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
              Plans are on pause.<br />
              <span className="pp-headline-soft">Back as soon as billing is live.</span>
            </h1>
            <p className="pp-sub">
              We're finishing setting up payments. Self-hosted is temporarily
              unavailable and Openship Cloud is coming soon — leave your email
              and we'll let you know the moment plans open up.
            </p>

            <ul className="pp-hero-trust">
              <li>Open source · Apache 2.0</li>
              <li>No lock-in</li>
              <li>Cloud or self-hosted</li>
              <li>Get notified at launch</li>
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
                  className={`pp-plan ${p.highlight ? "pp-plan--highlight" : ""} ${p.muted ? "pp-plan--muted" : ""}`}
                >
                  {p.ribbon && (
                    <span className={`pp-plan-ribbon ${p.ribbonMuted ? "pp-plan-ribbon--muted" : ""}`}>
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
                    {...(p.external ? { target: "_blank", rel: "noreferrer" } : {})}
                    className={`pp-plan-cta ${p.highlight ? "pp-plan-cta--filled" : ""} ${p.muted ? "pp-plan-cta--muted" : ""}`}
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
              <h2 className="pp-end-title">Want in when plans open?</h2>
              <p className="pp-end-sub">
                We're finishing billing setup — self-hosted is paused and Cloud
                is coming soon. Leave your email and you'll be first to know the
                moment plans go live.
              </p>
              <div className="pp-end-cta-row">
                <a href="/contact" className="pp-btn pp-btn--primary">
                  Get notified
                </a>
                <a href="/docs" className="pp-btn pp-btn--ghost">
                  Explore the platform
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
