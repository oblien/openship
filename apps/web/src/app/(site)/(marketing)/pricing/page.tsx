import { formatMemoryMb } from "@repo/core";
import { Navbar, Footer } from "@/components/landing";
import {
  STANDARD,
  UI,
  chooseLabel,
  priceParts,
  getCloudPricing,
  money,
  type PricedPlan,
  type CloudPricing,
} from "@/lib/pricing";
import { CLOUD_CTA_HREF, SELF_HOST_CTA_HREF, faq } from "./_data";
import { PricingProducts } from "./PricingProducts";
import { cloudPlanHref, managePlanHref } from "@/lib/cloud-links";

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
  const hasPool =
    pool?.max_total_vcpus != null &&
    pool.max_total_ram_mb != null &&
    pool.max_total_disk_gb != null;

  // Show finite allowances that distinguish the plans alongside shared capacity.
  const facts = [
    ...(plan.limits.maxProjects != null ? [{ label: "Projects & apps", value: count(plan.limits.maxProjects) }] : []),
    ...(plan.limits.runningServices != null ? [{ label: "Running services", value: count(plan.limits.runningServices) }] : []),
    ...(plan.limits.concurrentBuilds != null ? [{ label: "Concurrent builds", value: count(plan.limits.concurrentBuilds) }] : []),
    ...(plan.limits.buildMinutesPerMonth !== null
      ? [{ label: "Build time", value: `${count(plan.limits.buildMinutesPerMonth)} min/mo` }]
      : plan.billingMode !== "monthly" ? [{ label: "Build time", value: "Metered" }] : []),
  ];

  return (
    <div className="pp-plan-resources">
      {hasPool ? (
        <dl className="pp-plan-capacity" aria-label="Managed server capacity">
          {[
            { label: "vCPU", value: pool.max_total_vcpus!.toLocaleString("en") },
            { label: "RAM", value: formatMemoryMb(pool.max_total_ram_mb!) },
            { label: "Storage", value: `${pool.max_total_disk_gb!.toLocaleString("en")} GB` },
          ].map(({ label, value }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : <p className="pp-plan-capacity-fallback">See dashboard for server capacity</p>}
      {facts.length > 0 && (
        <dl className="pp-plan-limits">
          {facts.map(({ label, value }) => (
            <div className="pp-plan-limit" key={label}>
              <dt>{label}</dt><dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function CloudPlans({
  pricing,
  interval,
}: {
  pricing: CloudPricing;
  interval: "monthly" | "annual";
}) {
  return (
    <>
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
            const billingInterval =
              interval === "annual" && plan.price.annual != null ? "annual" : "monthly";
            const price = priceParts(plan, billingInterval);
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
                  {plan.billingMode === "monthly" ? (
                    billingInterval === "annual" ? (
                      `${money(plan.price.annual!)} billed yearly`
                    ) : (
                      "Billed monthly"
                    )
                  ) : plan.monthlyCredits === null ? (
                    "See dashboard for included credits"
                  ) : (
                    <>
                      <strong>{count(plan.monthlyCredits / 1000)}</strong> usage credits / month
                    </>
                  )}
                </p>
                <PlanResources plan={plan} />
                <p className="pp-plan-support">
                  {supportLabels[plan.support] ?? "See support options"}
                </p>
                <a
                  href={cloudPlanHref(plan.id, billingInterval)}
                  className={`pp-plan-cta ${plan.popular ? "pp-plan-cta--filled" : ""}`}
                >
                  {chooseLabel(plan.name)}
                </a>
              </article>
            );
          })}
        </div>
      )}

      {pricing.available && (
        <>
          <div className="pp-usage-note" id="usage">
            <p>
              {pricing.tiers.every((plan) => plan.billingMode === "monthly")
                ? "Each plan includes one Cloud Space, with CPU, RAM and storage covered for the paid period. Apps and builds share its capacity. Managed proxy transfer and backups are separate."
                : "Apps and builds share your Cloud Space’s capacity. Review the billing mode and included allowance before checkout."}
            </p>
            <a href="/docs/guides/billing">
              How billing works <span aria-hidden="true">↗</span>
            </a>
          </div>
          {pricing.management?.includedWithCloud && (
            <p className="pp-email-note">
              Paid Cloud Spaces also include basic management for{" "}
              {pricing.management.includedServers} customer-owned servers per workspace. Additional
              servers cost {money(pricing.management.extraServerMonthlyCents)} each per month.
            </p>
          )}
          <p className="pp-email-note">
            <strong>Managed email · Coming soon.</strong> Cloud server plans host applications; they
            do not provision a mail server. Self-hosted email remains available on your own server.
          </p>
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
    </>
  );
}

function ManagementPlans({ pricing }: { pricing: CloudPricing }) {
  const management = pricing.management;
  if (!management)
    return (
      <div className="pp-unavailable" role="status">
        <h3>We couldn’t load management pricing.</h3>
        <a className="pp-solid-cta" href={managePlanHref()}>
          View management plans
        </a>
      </div>
    );
  return (
    <>
      <div className="pp-plans pp-plans--management">
        {[
          {
            id: "basic" as const,
            name: "Manage",
            price: management.monthlyCents,
            support: "Email support",
            description: "Your servers. Our hosted control plane.",
          },
          ...(management.priorityMonthlyCents != null
            ? [
                {
                  id: "priority" as const,
                  name: "Manage Priority",
                  price: management.priorityMonthlyCents,
                  support: "Priority support",
                  description: "Server management with priority support from the Openship team.",
                },
              ]
            : []),
        ].map((plan) => (
          <article className="pp-plan" key={plan.id}>
            <h3 className="pp-plan-name">{plan.name}</h3>
            <p className="pp-plan-lead">{plan.description}</p>
            <div className="pp-plan-price">
              <span className="pp-plan-amt">{money(plan.price)}</span>
              <span className="pp-plan-per">/ month per workspace</span>
            </div>
            <p className="pp-plan-credits">
              Billed monthly. Includes {management.includedServers} customer-owned servers.
            </p>
            <p className="pp-plan-lead">
              Deployments, domains, logs, monitoring, backups, API, SDK and CLI access. Compute and
              storage are provided by you.
            </p>
            <p className="pp-plan-support">{plan.support}</p>
            <a className="pp-plan-cta" href={managePlanHref(plan.id)}>
              View {plan.name}
            </a>
          </article>
        ))}
      </div>
      <p className="pp-email-note">
        Additional servers cost {money(management.extraServerMonthlyCents)} each per month.
        {management.includedWithCloud &&
          ` Basic management for ${management.includedServers} servers is included with paid Cloud Spaces.`}
      </p>
    </>
  );
}

export default async function PricingPage() {
  const pricing = await getCloudPricing();

  return (
    <>
      <Navbar />
      <main className="pp-root">
        <section className="pp-hero">
          <div className="pp-hero-glow" aria-hidden="true" />
          <div className="pp-container pp-hero-inner">
            <p className="pp-eyebrow">Openship pricing</p>
            <h1 className="pp-headline">
              Start small. <span>Grow from here.</span>
            </h1>
            <p className="pp-sub">
              Managed builds, hosting, and HTTPS. Choose monthly or yearly billing.
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
              <p>Choose your billing period. Cancel renewal anytime.</p>
            </header>

            <PricingProducts
              cloud={<CloudPlans pricing={pricing} interval="monthly" />}
              annualCloud={
                pricing.available && pricing.annual.enabled ? (
                  <CloudPlans pricing={pricing} interval="annual" />
                ) : undefined
              }
              monthsFree={pricing.annual.monthsFree}
              management={<ManagementPlans pricing={pricing} />}
              infrastructure={
                <div className="pp-plans">
                  <article className="pp-plan">
                    <h3 className="pp-plan-name">Self-hosted</h3>
                    <p className="pp-plan-lead">Run the control plane on your infrastructure.</p>
                    <div className="pp-plan-price">
                      <span className="pp-plan-amt">Free</span>
                    </div>
                    <p className="pp-plan-lead">
                      The full open-source platform. You operate the control plane, servers, updates
                      and backups.
                    </p>
                    <p className="pp-plan-support">Community support</p>
                    <a className="pp-plan-cta" href={SELF_HOST_CTA_HREF}>
                      Start self-hosting
                    </a>
                  </article>
                  <article className="pp-plan">
                    <h3 className="pp-plan-name">Dedicated</h3>
                    <p className="pp-plan-lead">
                      Physical hardware with managed deployment and support.
                    </p>
                    <div className="pp-plan-price">
                      <span className="pp-plan-amt">Custom</span>
                    </div>
                    <p className="pp-plan-lead">
                      Hardware, region, capacity and support terms are confirmed in your quote
                      before purchase.
                    </p>
                    <a
                      className="pp-plan-cta"
                      href={
                        pricing.management
                          ? `mailto:${pricing.management.dedicatedContact}?subject=Dedicated%20Openship%20hosting`
                          : "/support"
                      }
                    >
                      Request a quote
                    </a>
                  </article>
                </div>
              }
            />
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
