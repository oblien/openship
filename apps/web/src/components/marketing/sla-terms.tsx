import type { Copy } from "@/i18n/copy";
import { Link } from "@/i18n/Link";
import { SUPPORT_EMAIL } from "@repo/core";
import { CLOUD_SLA } from "@/lib/cloud-service";

/** The same policy clauses appear on the SLA page and in the terms. */
export function getSlaSections(copy: Copy) {
  return [
    {
      id: "uptime-sla",
      title: copy("Uptime and SLA"),
      body: [
        copy(
          "OpenShip Cloud guarantees {value0}% monthly uptime for each paid Cloud Space, on every Cloud plan, whether billed monthly or annually. No enterprise plan or SLA add-on is required. The guarantee covers OpenShip-managed infrastructure, including infrastructure providers we choose to operate the service. It does not cover servers you host or connect yourself, free trials, or features expressly identified as preview or beta.",
          { value0: String(CLOUD_SLA.monthlyUptimePercent) },
        ),
        copy(
          "Downtime is a period when a failure of OpenShip-managed compute, storage, networking, routing, or control-plane services prevents your Cloud Space from running or serving otherwise working workloads, or prevents deployment and lifecycle operations such as starting or restarting workloads. A cosmetic dashboard issue alone is not downtime when those operations and workloads remain available.",
        ),
        copy(
          "We calculate uptime separately for each Cloud Space and each UTC calendar month: uptime percentage = 100 × (eligible minutes − downtime minutes) ÷ eligible minutes. Eligible minutes are the minutes your paid subscription and this SLA were both in effect during that month, excluding the periods described below. Excluded periods are removed from both the eligible time and downtime calculations. Overlapping incidents count once. We use the unrounded percentage to select a credit tier; a month with no eligible minutes has no SLA credit.",
        ),
        copy(
          "We verify the start and end of an outage using infrastructure monitoring, incident records, and reasonable evidence you provide. An outage is measured from its verified start until service is restored, not from when you first contact support. An isolated failed request is evidence to investigate, rather than proof that an entire period was unavailable.",
        ),
        copy(
          "Scheduled maintenance is excluded only when we announce the affected service and maintenance window at least {value0} days in advance by email or an in-app notice. Only downtime within that announced window is excluded. Emergency or unannounced maintenance, and downtime beyond the announced window, count unless another exclusion below applies.",
          { value0: String(CLOUD_SLA.maintenanceNoticeDays) },
        ),
        copy(
          "Other exclusions are periods caused by your application code or configuration, exceeding your purchased resource limits, intentional customer stops or customer-caused deployment interruptions, external dependencies you choose such as a repository, registry or DNS provider, or an internet connection outside our managed network. A suspension permitted by these terms, including for overdue payment or abuse, is excluded. A failure in our own billing or suspension systems is not excluded on that basis. Failure of an infrastructure provider we use is not, by itself, an exclusion. If both covered and excluded causes occur, we count any period in which a covered failure independently makes the service unavailable.",
        ),
      ],
    },
    {
      id: "sla-credits",
      title: copy("Service credits"),
      body: [
        copy(
          "If a Cloud Space’s verified monthly uptime is below {value0}%, you can claim a service credit at the following rates:",
          { value0: String(CLOUD_SLA.monthlyUptimePercent) },
        ),
        ...CLOUD_SLA.creditTiers.map((tier, index) => {
          const upper =
            index === 0
              ? CLOUD_SLA.monthlyUptimePercent
              : CLOUD_SLA.creditTiers[index - 1].minimumUptimePercent;
          return tier.minimumUptimePercent === 0
            ? copy("Below {value0}% uptime: a {value1}% service credit.", {
                value0: String(upper),
                value1: String(tier.creditPercent),
              })
            : copy("{value0}% to less than {value1}% uptime: a {value2}% service credit.", {
                value0: String(tier.minimumUptimePercent),
                value1: String(upper),
                value2: String(tier.creditPercent),
              });
        }),
        copy(
          "The percentage applies to the subscription fees attributable to the affected Cloud Space for that calendar month, after discounts and excluding taxes, usage add-ons and separately billed services. For an annual subscription, the monthly fee is one twelfth of the annual subscription fee. Partial months and plan changes are prorated to the applicable paid period and rate.",
        ),
        copy(
          "Only the highest applicable tier is awarded for each Cloud Space and month. Multiple incidents or claims do not stack, and the total SLA credit cannot exceed 100% of that Cloud Space’s applicable monthly subscription fee. Unaffected Cloud Spaces are calculated separately.",
        ),
        copy(
          "Approved credits are added to your account within {value0} days after approval and offset your next eligible OpenShip Cloud subscription invoice, including an annual renewal. Credits are not a cash refund and cannot be transferred to another account. These credits are the remedy provided by this SLA; they do not limit rights that cannot be excluded by applicable law. A separate written SLA takes precedence only where its terms expressly differ.",
          { value0: String(CLOUD_SLA.creditIssueDays) },
        ),
      ],
    },
    {
      id: "sla-claims",
      title: copy("Support and SLA claims"),
      body: [
        <>
          {copy(
            " Support is included with every Cloud plan. Report an incident or submit an SLA claim to",
          )}{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-4">
            {SUPPORT_EMAIL}
          </a>
          {copy(" , through Support in your app’s sidebar, or through our")}{" "}
          <Link href="/support" className="underline underline-offset-4">
            {copy(" public support page ")}
          </Link>{" "}
          {copy(
            " if you cannot sign in. Support response and resolution times are not guaranteed unless a separate written agreement specifies them. ",
          )}
        </>,
        copy(
          "Submit a credit claim within {value0} days after the end of the affected UTC calendar month. Include your account email, affected Cloud Space ID, outage dates and times with a timezone, and a brief description of what failed. Logs or screenshots help where available; remove passwords, tokens and other sensitive information before sending them. You do not need to open a separate ticket for every interruption in the same claim.",
          { value0: String(CLOUD_SLA.claimWindowDays) },
        ),
        copy(
          "We review our monitoring and incident records alongside your evidence and may ask for information needed to verify the claim. We will send a decision, the uptime calculation and any approved credit amount within {value0} business days after receiving the information needed to assess the claim. Credits are reviewed and issued through support; they are not applied automatically when an outage occurs.",
          { value0: String(CLOUD_SLA.claimReviewBusinessDays) },
        ),
      ],
    },
  ];
}
