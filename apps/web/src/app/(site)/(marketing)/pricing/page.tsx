import { Navbar, Footer } from "@/components/landing";
import {
  CUSTOM_TIERS,
  SELF_HOSTED,
  STANDARD,
  TIERS,
  UI,
  chooseLabel,
  cloudFrom,
  liveCampaigns,
  priceParts,
  renderNow,
} from "@/lib/pricing";
import { CLOUD_CTA_HREF, SELF_HOST_CTA_HREF, faq } from "./_data";

/**
 * Rendered per request, NOT prerendered.
 *
 * The page can carry a time-bounded campaign price, and a campaign has to start
 * and expire on its own. Two things are required for that and neither is
 * sufficient alone:
 *
 *   1. Prices are computed inside this component, from `renderNow()` — never in
 *      a module const. A module body runs once per process, which on a
 *      prerendered route is BUILD time.
 *   2. This declaration. `new Date()` is not one of Next's dynamic APIs, so
 *      without it the route would still be prerendered and every "per render"
 *      computation would happen exactly once, at build.
 *
 * `revalidate` over `force-dynamic`: a render is cheap in CPU, but
 * `force-dynamic` sends `private, no-cache, no-store`, which makes this the one
 * marketing route no CDN can ever serve — measured at ~9.5x lower throughput than
 * its prerendered siblings, on the page most likely to be linked and crawled.
 * A 60-second window costs only that a campaign can begin or end up to a minute
 * late, which is not a claim anyone can act on.
 *
 * The JSON-LD stays consistent under ISR: the layout and the page render in ONE
 * pass sharing `renderNow()`, so a revalidation bakes the structured data and the
 * visible price from the same instant. They can drift only if the two files are
 * given different windows — keep them equal.
 */
export const revalidate = 60;

function Check() {
  return (
    <svg className="pp-plan-check" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 10.5l4 4 8-10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ─── Page ───────────────────────────────────────────────────── */

export default function PricingPage() {
  const now = renderNow();
  const from = cloudFrom(now);
  const campaigns = liveCampaigns(now);
  const questions = faq(now);

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
              <span className="pp-headline-soft">
                {from ? `Cloud from ${from} a month.` : "Forever, on your own servers."}
              </span>
            </h1>
            <p className="pp-sub">
              Openship is open source under Apache 2.0 — run the whole platform on
              any Linux box for nothing, with no metering, no seat caps, and no
              credit card. Or let us run it: Openship Cloud is fully managed
              {from ? `, from ${from} a month` : ""}.
            </p>

            <ul className="pp-hero-trust">
              <li>Open source · Apache 2.0</li>
              <li>Free forever, self-hosted</li>
              <li>No lock-in</li>
              {from && <li>Cloud from {from}{UI.perMonth}</li>}
            </ul>
          </div>
        </section>

        {/* ── Self-hosted band ───────────────────────────────── */}
        <section className="pp-selfhost-section">
          <div className="pp-container">
            <div className="pp-selfhost">
              <div>
                <span className="pp-selfhost-tag">Open source</span>
                <h2 className="pp-selfhost-name">{SELF_HOSTED.name}</h2>
                <p className="pp-selfhost-lead">{SELF_HOSTED.tagline}</p>

                <div className="pp-selfhost-price">
                  <span className="pp-selfhost-amt">{SELF_HOSTED.priceLabel}</span>
                  <span className="pp-selfhost-note">{SELF_HOSTED.priceNote}</span>
                </div>

                <a href={SELF_HOST_CTA_HREF} className="pp-solid-cta">
                  {SELF_HOSTED.cta}
                </a>
              </div>

              <ul className="pp-selfhost-features">
                {SELF_HOSTED.features.map((f) => (
                  <li key={f}>
                    <Check />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ── Cloud plans ────────────────────────────────────── */}
        <section className="pp-plans-section">
          <div className="pp-container">
            <header className="pp-plans-head">
              <h2 className="pp-plans-title">Openship Cloud</h2>
              <p className="pp-plans-note">
                We run the servers, the edge, the backups. Same platform, same
                containers — start at no cost and move up when you outgrow it.
              </p>

              {/* Only rendered while the catalog has a live campaign. */}
              {campaigns.map((c) => (
                <p key={c.id} className="pp-campaign">
                  <span className="pp-campaign-badge">{c.badge}</span>
                  <span className="pp-campaign-ends">{c.ends}</span>
                </p>
              ))}
            </header>

            <div className="pp-plans">
              {TIERS.map((plan) => {
                const price = priceParts(plan, now);
                const free = plan.price.monthly === 0;
                return (
                  <article
                    key={plan.id}
                    className={`pp-plan ${plan.popular ? "pp-plan--highlight" : ""}`}
                  >
                    {plan.popular && <span className="pp-plan-ribbon">{UI.mostPopular}</span>}

                    <h3 className="pp-plan-name">{plan.name}</h3>
                    <p className="pp-plan-lead">{plan.description}</p>

                    <div className="pp-plan-price">
                      {price.badge && <span className="pp-plan-save">{price.badge}</span>}

                      <span className="pp-plan-amt">
                        {price.amount}
                        {price.per && <span className="pp-plan-per">{price.per}</span>}
                      </span>

                      {price.was && (
                        <span className="pp-plan-was">
                          {price.was.before}
                          <s>{price.was.value}</s>
                          {price.was.after}
                          {price.ends && <span className="pp-plan-ends">{price.ends}</span>}
                        </span>
                      )}

                      <span className="pp-plan-pricenote">
                        {free ? "no credit card" : UI.billedMonthly}
                      </span>
                    </div>

                    <a
                      href={CLOUD_CTA_HREF}
                      className={`pp-plan-cta ${plan.popular ? "pp-plan-cta--filled" : ""}`}
                    >
                      {free ? UI.ctaStart : chooseLabel(plan.name)}
                    </a>

                    {/* A lead-in, not a bullet — it used to carry a checkmark, which
                        made a sentence ending in a colon read as a feature. */}
                    {plan.inheritedFrom && (
                      <p className="pp-plan-inherits">{plan.inheritedFrom}</p>
                    )}

                    <ul className="pp-plan-features">
                      {plan.features.map((f) => (
                        <li key={f}>
                          <Check />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </article>
                );
              })}
            </div>

            {/* What every tier includes, stated ONCE.
                A tier's own bullets are its numbers; anything true on all of them
                belongs here instead of repeated down each column — repeating it was
                what made the audit log read as a Scale-only feature. */}
            <div className="pp-standard">
              <h3 className="pp-standard-title">{STANDARD.title}</h3>
              <ul className="pp-standard-features">
                {STANDARD.features.map((f) => (
                  <li key={f}>
                    <Check />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>

            {CUSTOM_TIERS.map((plan) => (
              <div key={plan.id} className="pp-ent">
                <div>
                  <h3 className="pp-ent-name">{plan.name}</h3>
                  <p className="pp-ent-lead">{plan.description}</p>
                  {/* Name → lead → price, the same order as the four tier cards, so
                      the eye finds "how much" in the same place it just left. */}
                  <p className="pp-ent-price">{UI.custom}</p>
                </div>

                <div>
                  {plan.inheritedFrom && (
                    <p className="pp-ent-inherits">{plan.inheritedFrom}</p>
                  )}
                  <ul className="pp-ent-features">
                    {plan.features.map((f) => (
                      <li key={f}>
                        <Check />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <a href={plan.contactSales ?? CLOUD_CTA_HREF} className="pp-solid-cta">
                  {UI.ctaContact}
                </a>
              </div>
            ))}
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
              {questions.map((f) => (
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
              <h2 className="pp-end-title">Your servers, or ours.</h2>
              <p className="pp-end-sub">
                Self-hosting is free and one command away on any Linux box. If
                you'd rather we ran it, Openship Cloud is live — start at no cost
                and pay only when you outgrow it.
              </p>
              <div className="pp-end-cta-row">
                <a href={SELF_HOST_CTA_HREF} className="pp-btn pp-btn--primary">
                  {SELF_HOSTED.cta}
                </a>
                <a href={CLOUD_CTA_HREF} className="pp-btn pp-btn--ghost">
                  {UI.ctaStart}
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
