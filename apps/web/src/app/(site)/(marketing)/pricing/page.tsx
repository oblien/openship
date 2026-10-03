import { formatCpuCores, formatMemoryMb, planServiceResources } from "@repo/core";
import { Navbar, Footer } from "@/components/landing";
import {
  STANDARD,
  UI,
  chooseLabel,
  cloudFrom,
  priceParts,
  getCloudPricing,
  type PricedPlan,
} from "@/lib/pricing";
import { CLOUD_CTA_HREF, SELF_HOST_CTA_HREF, faq } from "./_data";

// Match the public catalog and JSON-LD cache window.
export const revalidate = 60;

function Check() {
  return (
    <svg className="pp-plan-check" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M4 10.5l4 4 8-10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const supportLabels: Record<string, string> = {
  community: "Community support",
  email: "Email support",
  priority: "Priority support",
  dedicated: "Dedicated support",
};
const count = (value: number | null) =>
  value === null ? "No set limit" : value.toLocaleString("en");

function PlanResources({ plan }: { plan: PricedPlan }) {
  const pool = plan.resourceLimits;
  const service = planServiceResources(plan.limits);
  const hasPool =
    pool?.max_total_vcpus != null &&
    pool.max_total_ram_mb != null &&
    pool.max_total_disk_gb != null;

  return (
    <dl className="pp-plan-resources">
      <div className="pp-plan-resource">
        <dt>Managed server capacity</dt>
        <dd>
          {hasPool ? (
            <>
              {formatCpuCores(pool.max_total_vcpus!)} · {formatMemoryMb(pool.max_total_ram_mb!)} RAM
              <span>{pool.max_total_disk_gb!.toLocaleString("en")} GB disk</span>
            </>
          ) : (
            "See dashboard"
          )}
        </dd>
      </div>
      <div className="pp-plan-resource">
        <dt>Per service, up to</dt>
        <dd>
          {service
            ? `${formatCpuCores(service.cpuCores)} · ${formatMemoryMb(service.memoryMb)} RAM`
            : "Custom limits"}
        </dd>
      </div>
      <div className="pp-plan-limit">
        <dt>Projects</dt>
        <dd>{count(plan.limits.maxProjects)}</dd>
      </div>
      <div className="pp-plan-limit">
        <dt>Running services</dt>
        <dd>{count(plan.limits.runningServices)}</dd>
      </div>
      <div className="pp-plan-limit">
        <dt>Build time</dt>
        <dd>
          {plan.limits.buildMinutesPerMonth === null
            ? "Uses credits"
            : `${count(plan.limits.buildMinutesPerMonth)} min/mo`}
        </dd>
      </div>
    </dl>
  );
}

export default async function PricingPage() {
  const pricing = await getCloudPricing();
  const from = cloudFrom(pricing);

  return (
    <>
      <Navbar />
      <main className="pp-root">
        <section className="pp-hero">
          <div className="pp-hero-glow" aria-hidden="true" />
          <div className="pp-container pp-hero-inner">
            <p className="pp-eyebrow">Openship Cloud</p>
            <h1 className="pp-headline">
              Start small. <span>Grow from here.</span>
            </h1>
            <p className="pp-sub">
              Managed builds, hosting, and HTTPS.
              {from
                ? ` From ${from} a month, with room for your next big idea.`
                : " Choose the right plan for your next big idea."}
            </p>
            <ul className="pp-hero-trust">
              <li>
                <Check />
                No per-seat fees
              </li>
              <li>
                <Check />
                Bring your stack
              </li>
              <li>
                <Check />
                Track your usage
              </li>
            </ul>
          </div>
        </section>

        <section className="pp-plans-section" aria-labelledby="cloud-plans-title">
          <div className="pp-container">
            <header className="pp-plans-head">
              <h2 id="cloud-plans-title">Pick a plan. Start deploying.</h2>
              <p>Monthly billing · Cancel anytime</p>
            </header>

            {!pricing.available ? (
              <div className="pp-unavailable" role="status">
                <h3>We couldn’t load the current plans.</h3>
                <p>Check the dashboard for the latest prices and availability.</p>
                <a href={CLOUD_CTA_HREF} className="pp-solid-cta">
                  Open the dashboard
                </a>
              </div>
            ) : (
              <div className="pp-plans">
                {pricing.tiers.map((plan) => {
                  const price = priceParts(plan);
                  return (
                    <article
                      key={plan.id}
                      className={`pp-plan ${plan.popular ? "pp-plan--highlight" : ""}`}
                    >
                      <div className="pp-plan-heading">
                        <h3 className="pp-plan-name">{plan.name}</h3>
                        {plan.popular && <span className="pp-plan-ribbon">{UI.mostPopular}</span>}
                      </div>
                      <p className="pp-plan-lead">{plan.description}</p>
                      <div className="pp-plan-price">
                        <span className="pp-plan-amt">{price.amount}</span>
                        <span className="pp-plan-per">{price.per}</span>
                      </div>
                      <p className="pp-plan-credits">
                        {plan.monthlyCredits === null ? (
                          "See dashboard for included credits"
                        ) : (
                          <>
                            <strong>{count(plan.monthlyCredits / 1000)}</strong> usage credits /
                            month
                          </>
                        )}
                      </p>
                      <a
                        href={CLOUD_CTA_HREF}
                        className={`pp-plan-cta ${plan.popular ? "pp-plan-cta--filled" : ""}`}
                      >
                        {chooseLabel(plan.name)}
                      </a>
                      <PlanResources plan={plan} />
                      <p className="pp-plan-support">
                        <Check />
                        {supportLabels[plan.support] ?? "See support options"}
                      </p>
                    </article>
                  );
                })}
              </div>
            )}

            {pricing.available && (
              <>
                <div className="pp-usage-note" id="usage">
                  <p>
                    Credits cover metered app and build usage. Capacity is shared across your
                    projects; continuous hosting can require top-ups.
                  </p>
                  <a href="/docs/guides/billing">
                    How billing works <span aria-hidden="true">↗</span>
                  </a>
                </div>
                <div className="pp-standard">
                  <h3>{STANDARD.title}</h3>
                  <ul>
                    {STANDARD.features.map((feature) => (
                      <li key={feature}>
                        <Check />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            <div className="pp-options">
              {pricing.customTiers.map((plan) => (
                <div className="pp-option" key={plan.id}>
                  <h3>{plan.name}, built around your team.</h3>
                  <p>{plan.description}</p>
                  <a href={plan.contactSales ?? CLOUD_CTA_HREF}>
                    {UI.ctaContact} <span aria-hidden="true">↗</span>
                  </a>
                </div>
              ))}
              <div className="pp-option">
                <h3>Prefer your own servers?</h3>
                <p>
                  The full Openship platform is free to self-host. Open source, under Apache 2.0.
                </p>
                <a href={SELF_HOST_CTA_HREF}>
                  Start self-hosting <span aria-hidden="true">↗</span>
                </a>
              </div>
            </div>
          </div>
        </section>

        <section className="pp-faq-section">
          <div className="pp-container pp-faq-layout">
            <header className="pp-faq-head">
              <p className="pp-eyebrow">Good to know</p>
              <h2>
                Questions?
                <br />
                Let’s clear them up.
              </h2>
              <a href="/support">
                Talk to our team <span aria-hidden="true">↗</span>
              </a>
            </header>
            <div className="pp-faq-list">
              {faq(pricing).map((item) => (
                <details key={item.q} className="pp-faq-item">
                  <summary>
                    <span>{item.q}</span>
                    <svg className="pp-faq-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path
                        d="M5 8l5 5 5-5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="pp-end">
          <div className="pp-container">
            <div className="pp-end-card">
              <div>
                <h2>Less setup. More shipping.</h2>
                <p>Connect your repo and bring your next idea to life.</p>
              </div>
              <a href={CLOUD_CTA_HREF} className="pp-solid-cta">
                Get started with Cloud <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
