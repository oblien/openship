import type { ReactNode } from "react";
import { ArrowRight, Check, ChevronDown } from "lucide-react";
import { formatMemoryMb } from "@repo/core";
import { Navbar, Footer } from "@/components/landing";
import { IllustratedLink } from "@/components/marketing/illustrated-link";
import { CLOUD_SLA } from "@/lib/cloud-service";
import {
  STANDARD,
  UI,
  chooseLabel,
  cloudFrom,
  priceParts,
  getCloudPricing,
  cloudPlanSummary,
  money,
  type PricedPlan,
  type CloudPricing,
} from "@/lib/pricing";
import { CLOUD_CTA_HREF, SELF_HOST_CTA_HREF, faq } from "./_data";
import { CloudBilling } from "./CloudBilling";
import { cloudPlanHref, managePlanHref } from "@/lib/cloud-links";

export const revalidate = 60;

const supportLabels: Record<string, string> = {
  community: "Community support",
  email: "Email support",
  priority: "Priority support",
  dedicated: "Dedicated support",
};
const count = (value: number | null | undefined) =>
  value === undefined ? "Not listed" : value === null ? "No set limit" : value.toLocaleString("en");

type Fact = { label: string; value: string };

function PlanFacts({ facts }: { facts: Fact[] }) {
  return (
    <dl className="pp-plan-limits">
      {facts.map(({ label, value }) => (
        <div className="pp-plan-limit" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PlanCard({
  name,
  description,
  amount,
  per,
  billingNote,
  href,
  cta,
  popular,
  support,
  children,
}: {
  name: string;
  description: string;
  amount: string;
  per?: string | null;
  billingNote: ReactNode;
  href: string;
  cta: string;
  popular?: boolean;
  support: string;
  children: ReactNode;
}) {
  return (
    <article
      className={`pp-plan${popular ? " pp-plan--highlight" : ""}`}
      aria-label={`${name} plan`}
    >
      <div className="pp-plan-heading">
        <h3 className="pp-plan-name">{name}</h3>
        {popular && <span className="pp-plan-ribbon">{UI.mostPopular}</span>}
      </div>
      <p className="pp-plan-lead">{description}</p>
      <div className="pp-plan-price-block">
        <div className="pp-plan-price">
          <span className="pp-plan-amt">{amount}</span>
          {per && <span className="pp-plan-per">{per}</span>}
        </div>
        <p className="pp-plan-billing">{billingNote}</p>
      </div>
      <a href={href} className={`pp-plan-cta${popular ? " pp-plan-cta--filled" : ""}`}>
        {cta} <ArrowRight className="size-4" aria-hidden="true" />
      </a>
      <div className="pp-plan-details">{children}</div>
      <p className="pp-plan-support">
        <Check className="size-4" aria-hidden="true" />
        {support}
      </p>
    </article>
  );
}

function PlanResources({ plan }: { plan: PricedPlan }) {
  const pool = plan.resourceLimits;
  const capacity = [
    { label: "vCPU", value: pool?.max_total_vcpus != null ? count(pool.max_total_vcpus) : "—" },
    {
      label: "RAM",
      value: pool?.max_total_ram_mb != null ? formatMemoryMb(pool.max_total_ram_mb) : "—",
    },
    {
      label: "Storage",
      value: pool?.max_total_disk_gb != null ? `${count(pool.max_total_disk_gb)} GB` : "—",
    },
  ];
  const facts = [
    { label: "Projects", value: count(plan.limits.maxProjects) },
    { label: "Running services", value: count(plan.limits.runningServices) },
    { label: "Concurrent builds", value: count(plan.limits.concurrentBuilds) },
    ...(plan.limits.buildMinutesPerMonth !== null
      ? [{ label: "Build time", value: `${count(plan.limits.buildMinutesPerMonth)} min/mo` }]
      : plan.billingMode !== "monthly"
        ? [{ label: "Build time", value: "Metered" }]
        : []),
  ];
  return (
    <>
      <dl className="pp-plan-capacity" aria-label="Shared resource pool">
        {capacity.map(({ label, value }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <PlanFacts facts={facts} />
    </>
  );
}

function CloudPlans({
  pricing,
  interval,
}: {
  pricing: CloudPricing;
  interval: "monthly" | "annual";
}) {
  if (!pricing.available)
    return (
      <div className="pp-unavailable" role="status">
        <h3>Current plans are temporarily unavailable.</h3>
        <p>View the latest prices in Openship Cloud.</p>
        <a href={CLOUD_CTA_HREF} className="pp-solid-cta">
          Open Cloud <ArrowRight className="size-4" aria-hidden="true" />
        </a>
      </div>
    );
  return (
    <>
      <div className="pp-plans">
        {pricing.tiers.map((plan) => {
          const billingInterval =
            interval === "annual" && plan.price.annual != null ? "annual" : "monthly";
          const price = priceParts(plan, billingInterval);
          const billing =
            billingInterval === "annual"
              ? `${money(plan.price.annual!)} billed yearly`
              : "Billed monthly";
          return (
            <PlanCard
              key={plan.id}
              name={plan.name}
              description={cloudPlanSummary(plan)}
              amount={price.amount}
              per={price.per}
              billingNote={
                <>
                  {billing}
                  {plan.billingMode !== "monthly" && (
                    <>
                      <br />
                      {plan.monthlyCredits === null
                        ? "See included usage in Cloud"
                        : `${count(plan.monthlyCredits / 1000)} usage credits / month`}
                    </>
                  )}
                </>
              }
              href={cloudPlanHref(plan.id, billingInterval)}
              cta={chooseLabel(plan.name)}
              popular={plan.popular}
              support={supportLabels[plan.support] ?? "See support options"}
            >
              <PlanResources plan={plan} />
            </PlanCard>
          );
        })}
      </div>
      <div className="pp-billing-note">
        <p>
          {pricing.tiers.every((plan) => plan.billingMode === "monthly")
            ? "CPU, RAM and storage included. Apps and builds share capacity. Managed proxy transfer and backups are billed separately."
            : "Apps and builds share capacity. Review each plan’s billing mode and usage allowance before checkout."}
        </p>
        <a href="/docs/guides/billing">
          Billing details <ArrowRight className="size-3.5" aria-hidden="true" />
        </a>
      </div>
      <details className="pp-included">
        <summary>
          {STANDARD.title}
          <ChevronDown className="size-4" aria-hidden="true" />
        </summary>
        <ul>
          {STANDARD.features.map((feature) => (
            <li key={feature}>
              <Check className="size-4" aria-hidden="true" />
              {feature}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

function ManagementPlans({ pricing }: { pricing: CloudPricing }) {
  const management = pricing.management;
  if (!management)
    return (
      <div className="pp-unavailable" role="status">
        <h3>Management pricing is temporarily unavailable.</h3>
        <a className="pp-solid-cta" href={managePlanHref()}>
          View management plans
        </a>
      </div>
    );
  const plans = [
    {
      id: "basic" as const,
      name: "Manage",
      price: management.monthlyCents,
      support: "Email support",
      description: "Manage your own servers from Openship Cloud.",
    },
    ...(management.priorityMonthlyCents != null
      ? [
          {
            id: "priority" as const,
            name: "Manage Priority",
            price: management.priorityMonthlyCents,
            support: "Priority support",
            description: "The same server management, with priority support.",
          },
        ]
      : []),
  ];
  return (
    <>
      <div className="pp-plans pp-plans--alternative">
        {plans.map((plan) => (
          <PlanCard
            key={plan.id}
            name={plan.name}
            description={plan.description}
            amount={money(plan.price)}
            per="/ month"
            billingNote="Per workspace · Billed monthly"
            href={managePlanHref(plan.id)}
            cta={`Choose ${plan.name}`}
            support={plan.support}
          >
            <PlanFacts
              facts={[
                { label: "Servers included", value: count(management.includedServers) },
                {
                  label: "Additional server",
                  value: `${money(management.extraServerMonthlyCents)}/mo`,
                },
                { label: "Control plane", value: "Managed by Openship" },
                { label: "Compute & storage", value: "Your infrastructure" },
              ]}
            />
          </PlanCard>
        ))}
      </div>
      {management.includedWithCloud && (
        <p className="pp-billing-note">
          Basic management for {management.includedServers} of your own servers is also included
          with paid Cloud Spaces.
        </p>
      )}
    </>
  );
}

function InfrastructurePlans({ pricing }: { pricing: CloudPricing }) {
  return (
    <div className="pp-plans pp-plans--alternative">
      <PlanCard
        name="Self-hosted"
        description="Run the full platform on your infrastructure."
        amount="Free"
        billingNote="Open source · Apache 2.0"
        href={SELF_HOST_CTA_HREF}
        cta="Start self-hosting"
        support="Community support"
      >
        <PlanFacts
          facts={[
            { label: "Platform subscription", value: "None" },
            { label: "Control plane", value: "Self-managed" },
            { label: "Compute & storage", value: "Your infrastructure" },
          ]}
        />
      </PlanCard>
      <PlanCard
        name="Dedicated"
        description="Dedicated hardware for your capacity and support needs."
        amount="Custom"
        billingNote="Quoted for your requirements"
        href={
          pricing.management
            ? `mailto:${pricing.management.dedicatedContact}?subject=Dedicated%20Openship%20hosting`
            : "/support"
        }
        cta="Request a quote"
        support="Support agreed in your quote"
      >
        <PlanFacts
          facts={[
            { label: "Hardware", value: "Dedicated" },
            { label: "Region & capacity", value: "By agreement" },
            { label: "Setup & support", value: "Tailored to your team" },
          ]}
        />
      </PlanCard>
    </div>
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
          <div className="site-container pp-hero-inner">
            <h1 className="pp-headline">
              Cloud resources for your projects.
              <br />
              <span>{from ? `From ${from}/month.` : "Choose your capacity."}</span>
            </h1>
          </div>
        </section>
        <section id="plans" className="pp-plans-section" aria-label="Plans and hosting options">
          <div className="site-container">
            <div
              className="pp-cloud-benefits"
              role="group"
              aria-label="Included with every Cloud plan"
            >
              <IllustratedLink
                href={CLOUD_SLA.termsHref}
                illustration="deployment-health-checks"
                heading="h2"
                title={`${CLOUD_SLA.monthlyUptimePercent}% uptime guarantee`}
                description="Monthly SLA with service credits on every Cloud plan."
              />
              <IllustratedLink
                href="/support"
                illustration="notifications"
                heading="h2"
                title="Support included"
                description="Email us or open Support in your app’s sidebar."
              />
            </div>
            <CloudBilling
              monthly={<CloudPlans pricing={pricing} interval="monthly" />}
              annual={
                pricing.available && pricing.annual.enabled ? (
                  <CloudPlans pricing={pricing} interval="annual" />
                ) : undefined
              }
              monthsFree={pricing.annual.monthsFree}
            />
            {pricing.customTiers.map((plan) => (
              <div className="pp-enterprise" key={plan.id}>
                <p>
                  <strong>{plan.name}</strong>
                  <span>{plan.description}</span>
                </p>
                <a href={plan.contactSales ?? CLOUD_CTA_HREF} className="pp-text-link">
                  {UI.ctaContact} <ArrowRight className="size-4" aria-hidden="true" />
                </a>
              </div>
            ))}
          </div>
        </section>
        <section className="pp-offering-section" aria-labelledby="management-title">
          <div className="site-container">
            <header className="pp-section-heading">
              <div>
                <h2 id="management-title">Manage your own servers</h2>
                <p>Use Openship Cloud to manage infrastructure you already own.</p>
              </div>
            </header>
            <ManagementPlans pricing={pricing} />
          </div>
        </section>
        <section className="pp-offering-section" aria-labelledby="infrastructure-title">
          <div className="site-container">
            <header className="pp-section-heading">
              <div>
                <h2 id="infrastructure-title">Self-hosted or dedicated</h2>
                <p>Run the platform yourself, or arrange dedicated infrastructure.</p>
              </div>
            </header>
            <InfrastructurePlans pricing={pricing} />
          </div>
        </section>
        <section className="pp-faq-section">
          <div className="site-container pp-faq-layout">
            <header className="pp-faq-head">
              <h2>Pricing questions</h2>
              <a href="/support" className="pp-text-link">
                Talk to our team <ArrowRight className="size-4" aria-hidden="true" />
              </a>
            </header>
            <div className="pp-faq-list">
              {faq(pricing).map((item) => (
                <details key={item.q} className="pp-faq-item">
                  <summary>
                    <span>{item.q}</span>
                    <ChevronDown className="pp-faq-icon" aria-hidden="true" />
                  </summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
