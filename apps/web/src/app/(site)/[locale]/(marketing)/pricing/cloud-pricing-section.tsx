import { useCopy } from "@/i18n/use-copy";
import { getLocale } from "next-intl/server";
import { getCopy } from "@/i18n/copy-server";
import { ArrowRight, Check, ChevronDown } from "lucide-react";
import { formatMemoryMb, resolveStandard } from "@repo/core";
import { IllustratedLink } from "@/components/marketing/illustrated-link";
import { CLOUD_SLA, cloudSlaPlanSummary, cloudSlaUptimePercent } from "@/lib/cloud-service";
import {
  UI,
  startingCloudPlan,
  priceParts,
  getCloudPricing,
  cloudPlanSummary,
  type PricedPlan,
  type CloudPricing,
} from "@/lib/pricing";
import { CLOUD_CTA_HREF } from "./_data";
import { CloudBilling } from "./CloudBilling";
import { cloudPlanHref } from "@/lib/cloud-links";

import { PlanCard, PlanFacts, formatPlanCount } from "./plan-card";

const supportLabels: Record<string, string> = {
  community: "Community support",
  email: "Email support",
  priority: "Priority support",
  dedicated: "Dedicated support",
};
function PlanResources({ plan }: { plan: PricedPlan }) {
  const copy = useCopy();

  const pool = plan.resourceLimits;
  const capacity = [
    { label: "vCPU", value: pool?.max_total_vcpus != null ? formatPlanCount(pool.max_total_vcpus) : "—" },
    {
      label: "RAM",
      value: pool?.max_total_ram_mb != null ? formatMemoryMb(pool.max_total_ram_mb) : "—",
    },
    {
      label: copy("Storage"),
      value: pool?.max_total_disk_gb != null ? `${formatPlanCount(pool.max_total_disk_gb)} GB` : "—",
    },
  ];
  const facts = [
    { label: copy("Projects"), value: formatPlanCount(plan.limits.maxProjects) },
    { label: copy("Running services"), value: formatPlanCount(plan.limits.runningServices) },
    { label: copy("Concurrent builds"), value: formatPlanCount(plan.limits.concurrentBuilds) },
    ...(plan.limits.buildMinutesPerMonth !== null
      ? [
          {
            label: copy("Build time"),
            value: copy("{minutes} min/month", {
              minutes: formatPlanCount(plan.limits.buildMinutesPerMonth),
            }),
          },
        ]
      : plan.billingMode !== "monthly"
        ? [{ label: copy("Build time"), value: "Metered" }]
        : []),
    {
      label: copy("Monthly uptime SLA"),
      value: `${cloudSlaUptimePercent(plan.id)}%`,
      href: CLOUD_SLA.termsHref,
    },
  ];
  return (
    <>
      <dl className="pp-plan-capacity" aria-label={copy("Shared resource pool")}>
        {capacity.map(({ label, value }) => (
          <div key={label}>
            <dt>{copy(label)}</dt>
            <dd><bdi>{copy(value)}</bdi></dd>
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
  const plans = pricing.tiers.filter((plan) => plan.price[interval] != null);

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
        {plans.map((plan) => {
          const price = priceParts(plan, interval);
          const billing =
            interval === "annual"
              ? pricing.annual.monthsFree > 0
                ? copy("{months} months free", { months: pricing.annual.monthsFree })
                : copy("Billed yearly")
              : copy("Billed monthly");
          return (
            <PlanCard
              key={plan.id}
              name={plan.name}
              description={plan.description || cloudPlanSummary(plan, copy)}
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
                            credits: formatPlanCount(plan.monthlyCredits / 1000),
                          })}
                    </>
                  )}
                </>
              }
              href={cloudPlanHref(plan.id, interval)}
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
          {plans.every((plan) => plan.billingMode === "monthly")
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

export async function CloudPricingSection({ showHeadline = false }: { showHeadline?: boolean }) {
  const copy = await getCopy();

  const pricing = await getCloudPricing(await getLocale());
  const billingView = (interval: "monthly" | "annual") => {
    const startingPlan = startingCloudPlan(pricing, interval);
    const yearly = interval === "annual";
    return {
      plans: <CloudPlans pricing={pricing} interval={interval} />,
      headline: startingPlan
        ? copy.rich(
            yearly ? "From <price>{amount}</price>/year" : "From <price>{amount}</price>/month",
            {
              amount: priceParts(startingPlan, interval).amount,
              price: (amount) => <bdi dir="ltr">{amount}</bdi>,
            },
          )
        : copy("Choose your capacity."),
      note: !startingPlan
        ? null
        : yearly
          ? pricing.annual.monthsFree > 0
            ? copy("{months} months free", { months: pricing.annual.monthsFree })
            : copy("Billed yearly")
          : copy("Billed monthly"),
    };
  };
  return (
    <CloudBilling
      showHeadline={showHeadline}
      monthly={billingView("monthly")}
      annual={
        pricing.annual.enabled && startingCloudPlan(pricing, "annual")
          ? billingView("annual")
          : undefined
      }
      monthsFree={pricing.annual.monthsFree}
    >
      <div
        className="pp-cloud-benefits"
        role="group"
        aria-label={copy("Included with every Cloud plan")}
      >
        <IllustratedLink
          href={CLOUD_SLA.termsHref}
          illustration="deployment-health-checks"
          heading="h2"
          title={copy("Cloud uptime SLA")}
          description={cloudSlaPlanSummary(copy)}
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
    </CloudBilling>
  );
}
