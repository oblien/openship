import { getLocale } from "next-intl/server";
import { ArrowRight, ChevronDown } from "lucide-react";
import { Footer, Navbar } from "@/components/landing";
import { getCopy } from "@/i18n/copy-server";
import { Link } from "@/i18n/Link";
import { useCopy } from "@/i18n/use-copy";
import { PublicMailPlans } from "./public-mail-plans";
import { cloudEmailPlanHref, managePlanHref } from "@/lib/cloud-links";
import { getCloudPricing, money, type CloudPricing } from "@/lib/pricing";
import { SELF_HOST_CTA_HREF, faq } from "./_data";
import { CloudPricingSection } from "./cloud-pricing-section";
import { PlanCard, PlanFacts, formatPlanCount } from "./plan-card";

export const revalidate = 60;

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
                { label: "Servers included", value: formatPlanCount(management.includedServers) },
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

function MailPlans({ pricing }: { pricing: CloudPricing }) {
  const copy = useCopy();
  return (
    <section
      id="email-plans"
      className="pp-offering-section scroll-mt-24"
      aria-labelledby="email-plans-title"
    >
      <div className="site-container">
        <header className="pp-section-heading">
          <div>
            <h2 id="email-plans-title">{copy("OpenShip Mail plans")}</h2>
            <p>{copy("Choose where your messages live and how much mail you send.")}</p>
          </div>
          <Link className="pp-text-link" href="/mail#mail-pricing">
            {copy("Compare features")} <ArrowRight className="size-4" />
          </Link>
        </header>
        {pricing.mail ? (
          <PublicMailPlans catalog={pricing.mail} />
        ) : (
          <div className="pp-unavailable" role="status">
            <p>{copy("Current plans are temporarily unavailable.")}</p>
            <a href={cloudEmailPlanHref()} className="pp-solid-cta">
              {copy("View dashboard plans")}
            </a>
          </div>
        )}
      </div>
    </section>
  );
}

function InfrastructurePlans() {
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
        href="/contact"
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
  return (
    <>
      <Navbar />
      <main className="pp-root">
        <CloudPricingSection showHeadline />
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
        <MailPlans pricing={pricing} />
        <section className="pp-offering-section" aria-labelledby="infrastructure-title">
          <div className="site-container">
            <header className="pp-section-heading">
              <div>
                <h2 id="infrastructure-title">{copy("Self-hosted or dedicated")}</h2>
                <p>{copy("Run the platform yourself, or arrange dedicated infrastructure.")}</p>
              </div>
            </header>
            <InfrastructurePlans />
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
