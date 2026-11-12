import type { Copy } from "@/i18n/copy";
import { UI, money, paidLadder, type CloudPricing } from "@/lib/pricing";
import { cloudPlanHref } from "@/lib/cloud-links";
import { CLOUD_SLA } from "@/lib/cloud-service";

export interface FaqItem {
  q: string;
  a: string;
}

export function faq(pricing: CloudPricing, copy: Copy): FaqItem[] {
  const ladder = paidLadder(pricing);

  return [
    {
      q: copy("How much does OpenShip Cloud cost?"),
      a: [
        ladder
          ? copy("Plans are {value0}, {value1}.", {
              value0: String(ladder),
              value1: String(UI.billedMonthly),
            })
          : copy("See your dashboard for current Cloud plans and availability."),
        pricing.annual.enabled
          ? copy(
              "Yearly billing is also available; the cards show the monthly equivalent and full yearly charge.",
            )
          : null,
        copy(
          "Each subscription includes one Cloud Space for your projects, with no per-seat fees. Share the included CPU, RAM and storage across your projects and builds.",
        ),
        pricing.customTiers.length > 0
          ? copy("Enterprise limits and pricing are agreed with sales.")
          : null,
      ]
        .filter((text): text is string => text !== null)
        .join(" "),
    },
    {
      q: copy("What does a Cloud Space include?"),
      a: copy(
        "A Cloud Space is a shared resource pool. Its subscription covers the purchased CPU, RAM and storage for the entire paid period. Your apps and builds share those resources, with no second compute-credit allowance. Managed proxy transfer and backups are separate. Existing subscriptions keep their saved terms, shown in Billing.",
      ),
    },
    {
      q: copy("Do all Cloud plans include an uptime SLA and support?"),
      a: copy(
        "Yes. Every paid OpenShip Cloud plan includes a {value0}% monthly uptime guarantee for OpenShip-managed infrastructure, whether billed monthly or annually. If we miss it, you can request service credits under the Cloud SLA in our Terms of Service. Maintenance announced at least {value1} days in advance is excluded only within its announced window. Contact support by email, through the app, or from our public support page. The guarantee does not cover servers you host yourself, free trials, or preview and beta features.",
        {
          value0: String(CLOUD_SLA.monthlyUptimePercent),
          value1: String(CLOUD_SLA.maintenanceNoticeDays),
        },
      ),
    },
    {
      q: copy("How is capacity shared?"),
      a: copy(
        "Your projects and builds share the Cloud Space’s CPU, RAM and disk. Container limits do not allocate another machine or disk. Your dashboard shows actual usage separately from purchased capacity; add another Cloud Space when you need a separate resource pool.",
      ),
    },
    {
      q: copy("Can I change or cancel my plan?"),
      a: copy(
        "Cancel renewal from Billing and keep access until the end of your paid period. Upgrades use the provider’s prorated price and apply after payment. Resource reductions and billing-mode changes start at renewal. Review the amount due, effective date and any required restarts before confirming. Retained disks can incur storage charges after coverage ends until they are deleted.",
      ),
    },
    {
      q: copy("Can I manage my own servers from Cloud?"),
      a: pricing.management
        ? copy(
            "{value0}Standalone management starts at {value1} per workspace per month for {value2} servers. Additional servers cost {value3} each per month. You provide the compute and storage.",
            {
              value0: String(
                pricing.management.includedWithCloud
                  ? copy(
                      "Paid Cloud Spaces include basic management for {value0} of your own servers. ",
                      { value0: String(pricing.management.includedServers) },
                    )
                  : "",
              ),
              value1: String(money(pricing.management.monthlyCents)),
              value2: String(pricing.management.includedServers),
              value3: String(money(pricing.management.extraServerMonthlyCents)),
            },
          )
        : copy(
            "Choose Server management to see the current plans for managing your own infrastructure through OpenShip Cloud.",
          ),
    },
    {
      q: copy("Is managed email included?"),
      a: copy(
        "Cloud resource pools host your applications; they do not provision a mail server. Managed email is coming soon. Self-hosted mail is available on your own server.",
      ),
    },
    {
      q: copy("What happens if I cancel Manage?"),
      a: copy(
        "Management remains available through your paid period. Your apps, databases and files keep running on your servers. Once the allowance ends, OpenShip Cloud stops managing those servers; it does not delete or stop them. You can manage them directly or subscribe again.",
      ),
    },
    {
      q: copy("Is self-hosting really free?"),
      a: copy(
        "Yes. Run the full OpenShip platform on your own servers, free under Apache 2.0, with no OpenShip subscription or per-seat fees. You pay your infrastructure provider directly.",
      ),
    },
    {
      q: copy("Can I move between Cloud and my own servers?"),
      a: copy(
        "Yes. OpenShip uses standard containers and supports migration between Cloud and your own infrastructure. Your apps are portable, so you can choose where they run as your needs change.",
      ),
    },
  ];
}

export const CLOUD_CTA_HREF = cloudPlanHref();
export const SELF_HOST_CTA_HREF = "/docs/getting-started/quickstart";
