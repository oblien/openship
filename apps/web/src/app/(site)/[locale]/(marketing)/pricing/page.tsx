import { Link } from "@/i18n/Link";
import { useCopy } from "@/i18n/use-copy";
import { getLocale } from "next-intl/server";

import { getCopy } from "@/i18n/copy-server";
import type { ReactNode } from "react";
import { ArrowRight, Check, ChevronDown } from "lucide-react";
import { formatMemoryMb, resolveStandard } from "@repo/core";
import { Navbar, Footer } from "@/components/landing";
import { IllustratedLink } from "@/components/marketing/illustrated-link";
import { CLOUD_SLA } from "@/lib/cloud-service";
import {
  UI,
  startingCloudPlan,
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
  const copy = useCopy();

  return (
    <dl className="pp-plan-limits">
      {facts.map(({ label, value }) => (
        <div className="pp-plan-limit" key={label}>
          <dt>{copy(label)}</dt>
          <dd>{copy(value)}</dd>
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
  benefits = [],
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
  benefits?: string[];
  children: ReactNode;
}) {
  const copy = useCopy();

  return (
    <article
      className={`pp-plan${popular ? " pp-plan--highlight" : ""}`}
      aria-label={copy("{value0} plan", { value0: String(name) })}
    >
      <div className="pp-plan-heading">
        <h3 className="pp-plan-name">{copy(name)}</h3>
        {popular && <span className="pp-plan-ribbon">{copy(UI.mostPopular)}</span>}
      </div>
      <p className="pp-plan-lead">{copy(description)}</p>
      <div className="pp-plan-price-block">
        <div className="pp-plan-price">
          <span className="pp-plan-amt">{copy(amount)}</span>
          {per && <span className="pp-plan-per">{copy(per)}</span>}
        </div>
        <p className="pp-plan-billing">{copy(billingNote)}</p>
      </div>
      <a href={href} className={`pp-plan-cta${popular ? " pp-plan-cta--filled" : ""}`}>
        {copy(cta)} <ArrowRight className="size-4" aria-hidden="true" />
      </a>
      <div className="pp-plan-details">{children}</div>
      <ul className="pp-plan-support">
        {[...benefits, support].map((benefit) => (
          <li key={benefit}>
            <Check className="size-4" aria-hidden="true" />
            {copy(benefit)}
          </li>
        ))}
      </ul>
    </article>
  );
}

function PlanResources({ plan }: { plan: PricedPlan }) {
  const copy = useCopy();

  const pool = plan.resourceLimits;
  const capacity = [
    { label: "vCPU", value: pool?.max_total_vcpus != null ? count(pool.max_total_vcpus) : "—" },
    {
      label: "RAM",
      value: pool?.max_total_ram_mb != null ? formatMemoryMb(pool.max_total_ram_mb) : "—",
    },
    {
      label: copy("Storage"),
      value: pool?.max_total_disk_gb != null ? `${count(pool.max_total_disk_gb)} GB` : "—",
    },
  ];
  const facts = [
    { label: copy("Projects"), value: count(plan.limits.maxProjects) },
    { label: copy("Running services"), value: count(plan.limits.runningServices) },
    { label: copy("Concurrent builds"), value: count(plan.limits.concurrentBuilds) },
    ...(plan.limits.buildMinutesPerMonth !== null
      ? [
          {
            label: copy("Build time"),
            value: copy("{minutes} min/month", {
              minutes: count(plan.limits.buildMinutesPerMonth),
            }),
          },
        ]
      : plan.billingMode !== "monthly"
        ? [{ label: copy("Build time"), value: "Metered" }]
        : []),
  ];
  return (
    <>
      <dl className="pp-plan-capacity" aria-label={copy("Shared resource pool")}>
        {capacity.map(({ label, value }) => (
          <div key={label}>
            <dt>{copy(label)}</dt>
            <dd>{copy(value)}</dd>
          </div>
        ))}
      </dl>
      <PlanFacts facts={facts} />
    </>
  );
}

async function CloudPlans({
  pricing,
  interval,
}: {
  pricing: CloudPricing;
  interval: "monthly" | "annual";
}) {
  const copy = await getCopy();
  const standard = resolveStandard(await getLocale());

  if (!pricing.available)
    return (
      <div className="pp-unavailable" role="status">
        <h3>{copy("Current plans are temporarily unavailable.")}</h3>
        <p>{copy("View the latest prices in OpenShip Cloud.")}</p>
        <a href={CLOUD_CTA_HREF} className="pp-solid-cta">
          {copy("Open Cloud ")}
          <ArrowRight className="size-4" aria-hidden="true" />
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
              ? copy("{value0} billed yearly", { value0: String(money(plan.price.annual!)) })
              : copy("Billed monthly");
          return (
            <PlanCard
              key={plan.id}
              name={plan.name}
              description={cloudPlanSummary(plan, copy)}
              amount={price.amount}
              per={copy(price.per)}
              billingNote={
                <>
                  {billing}
                  {plan.billingMode !== "monthly" && (
                    <>
                      <br />
                      {plan.monthlyCredits === null
                        ? copy("See included usage in Cloud")
                        : copy("{credits} usage credits / month", {
                            credits: count(plan.monthlyCredits / 1000),
                          })}
                    </>
                  )}
                </>
              }
              href={cloudPlanHref(plan.id, billingInterval)}
              cta={copy("Choose {name}", { name: plan.name })}
              popular={plan.popular}
              support={supportLabels[plan.support] ?? "See support options"}
              benefits={
                pricing.management?.includedWithCloud
                  ? [
                      copy("Free management for {count} servers", {
                        count: pricing.management.includedServers,
                      }),
                    ]
                  : []
              }
            >
              <PlanResources plan={plan} />
            </PlanCard>
          );
        })}
      </div>
      <div className="pp-billing-note">
        <p>
          {pricing.tiers.every((plan) => plan.billingMode === "monthly")
            ? copy(
                "CPU, RAM and storage included. Apps and builds share capacity. Managed proxy transfer and backups are billed separately.",
              )
            : copy(
                "Apps and builds share capacity. Review each plan’s billing mode and usage allowance before checkout.",
              )}
        </p>
        <a href="/docs/guides/billing">
          {copy("Billing details ")}
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </a>
      </div>
      <details className="pp-included">
        <summary>
          {standard.title}
          <ChevronDown className="size-4" aria-hidden="true" />
        </summary>
        <ul>
          {standard.features.map((feature) => (
            <li key={feature}>
              <Check className="size-4" aria-hidden="true" />
              {copy(feature)}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

function ManagementPlans({ pricing }: { pricing: CloudPricing }) {
  const copy = useCopy();

  const management = pricing.management;
  if (!management)
    return (
      <div className="pp-unavailable" role="status">
        <h3>{copy("Management pricing is temporarily unavailable.")}</h3>
        <a className="pp-solid-cta" href={managePlanHref()}>
          {copy("View management plans")}
        </a>
      </div>
    );
  const plans = [
    {
      id: "basic" as const,
      name: copy("Manage"),
      price: management.monthlyCents,
      support: "Email support",
      description: copy("Manage your own servers from OpenShip Cloud."),
    },
    ...(management.priorityMonthlyCents != null
      ? [
          {
            id: "priority" as const,
            name: copy("Manage Priority"),
            price: management.priorityMonthlyCents,
            support: "Priority support",
            description: copy("The same server management, with priority support."),
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
            description={copy(plan.description)}
            amount={money(plan.price)}
            per="/ month"
            billingNote="Per workspace · Billed monthly"
            href={managePlanHref(plan.id)}
            cta={copy("Choose {name}", { name: plan.name })}
            support={plan.support}
          >
            <PlanFacts
              facts={[
                { label: "Servers included", value: count(management.includedServers) },
                {
                  label: "Additional server",
                  value: copy("{amount}/month", {
                    amount: money(management.extraServerMonthlyCents),
                  }),
                },
                { label: "Control plane", value: "Managed by OpenShip" },
                { label: "Compute & storage", value: "Your infrastructure" },
              ]}
            />
          </PlanCard>
        ))}
      </div>
      {management.includedWithCloud && (
        <p className="pp-billing-note">
          {copy(
            "Basic management for {count} of your own servers is also included with paid Cloud Spaces.",
            { count: management.includedServers },
          )}
        </p>
      )}
    </>
  );
}

function InfrastructurePlans({ pricing }: { pricing: CloudPricing }) {
  const copy = useCopy();

  return (
    <div className="pp-plans pp-plans--alternative">
      <PlanCard
        name="Self-hosted"
        description={copy("Run the full platform on your infrastructure.")}
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
        description={copy("Dedicated hardware for your capacity and support needs.")}
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
  const copy = await getCopy();

  const pricing = await getCloudPricing(await getLocale());
  const startingPlan = startingCloudPlan(pricing);
  const startingInterval =
    pricing.annual.enabled && startingPlan?.price.annual != null ? "annual" : "monthly";
  const from = startingPlan ? priceParts(startingPlan, startingInterval).amount : null;
  return (
    <>
      <Navbar />
      <main className="pp-root">
        <section className="pp-hero">
          <div className="site-container pp-hero-inner">
            <h1 className="pp-headline">
              {copy("Cloud resources for your projects.")}
              <br />
              <span>
                {from
                  ? copy.rich("From <price>{amount}</price>/month", {
                      amount: from,
                      price: (amount) => <bdi dir="ltr">{amount}</bdi>,
                    })
                  : copy("Choose your capacity.")}
              </span>
            </h1>
            {startingInterval === "annual" && startingPlan?.price.annual != null && (
              <p className="pp-hero-billing">
                {copy.rich("<price>{amount}</price> billed yearly", {
                  amount: money(startingPlan.price.annual),
                  price: (amount) => <bdi dir="ltr">{amount}</bdi>,
                })}
              </p>
            )}
          </div>
        </section>
        <section
          id="plans"
          className="pp-plans-section"
          aria-label={copy("Plans and hosting options")}
        >
          <div className="site-container">
            <CloudBilling
              monthly={<CloudPlans pricing={pricing} interval="monthly" />}
              annual={
                pricing.available && pricing.annual.enabled ? (
                  <CloudPlans pricing={pricing} interval="annual" />
                ) : undefined
              }
              monthsFree={pricing.annual.monthsFree}
            />
            <div
              className="pp-cloud-benefits"
              role="group"
              aria-label={copy("Included with every Cloud plan")}
            >
              <IllustratedLink
                href={CLOUD_SLA.termsHref}
                illustration="deployment-health-checks"
                heading="h2"
                title={copy("{value0}% uptime guarantee", {
                  value0: String(CLOUD_SLA.monthlyUptimePercent),
                })}
                description={copy("Monthly SLA with service credits on every Cloud plan.")}
              />
              <IllustratedLink
                href="/support"
                illustration="notifications"
                heading="h2"
                title={copy("Support included")}
                description={copy("Email us or open Support in your app’s sidebar.")}
              />
            </div>
            {pricing.customTiers.map((plan) => (
              <div className="pp-enterprise" key={plan.id}>
                <p>
                  <strong>{copy(plan.name)}</strong>
                  <span>{copy(plan.description)}</span>
                </p>
                <a href={plan.contactSales ?? CLOUD_CTA_HREF} className="pp-text-link">
                  {copy(UI.ctaContact)} <ArrowRight className="size-4" aria-hidden="true" />
                </a>
              </div>
            ))}
          </div>
        </section>
        <section className="pp-offering-section" aria-labelledby="management-title">
          <div className="site-container">
            <header className="pp-section-heading">
              <div>
                <h2 id="management-title">{copy("Manage your own servers")}</h2>
                <p>{copy("Use OpenShip Cloud to manage infrastructure you already own.")}</p>
              </div>
            </header>
            <ManagementPlans pricing={pricing} />
          </div>
        </section>
        <section className="pp-offering-section" aria-labelledby="infrastructure-title">
          <div className="site-container">
            <header className="pp-section-heading">
              <div>
                <h2 id="infrastructure-title">{copy("Self-hosted or dedicated")}</h2>
                <p>{copy("Run the platform yourself, or arrange dedicated infrastructure.")}</p>
              </div>
            </header>
            <InfrastructurePlans pricing={pricing} />
          </div>
        </section>
        <section className="pp-faq-section">
          <div className="site-container pp-faq-layout">
            <header className="pp-faq-head">
              <h2>{copy("Pricing questions")}</h2>
              <Link href="/support" className="pp-text-link">
                {copy("Talk to our team ")}
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </header>
            <div className="pp-faq-list">
              {faq(pricing, copy).map((item) => (
                <details key={item.q} className="pp-faq-item">
                  <summary>
                    <span>{copy(item.q)}</span>
                    <ChevronDown className="pp-faq-icon" aria-hidden="true" />
                  </summary>
                  <p>{copy(item.a)}</p>
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
