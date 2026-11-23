import type { Copy } from "@/i18n/copy";
import { Link } from "@/i18n/Link";
import { SUPPORT_EMAIL } from "@repo/core";
import { CLOUD_SLA, cloudSlaPlanSummary } from "@/lib/cloud-service";

/** The same policy clauses appear on the SLA page and in the terms. */
export function getSlaSections(copy: Copy) {
  return [
    {
      id: "uptime-sla",
      title: copy("Uptime and SLA"),
      body: [
        cloudSlaPlanSummary(copy),
        copy(
          "This SLA applies to each paid OpenShip Cloud Space, on monthly and annual subscriptions. It covers OpenShip-managed infrastructure, including the providers we use to operate it. Other paid Cloud tiers receive the Hobby and Starter commitment unless a written agreement specifies a different one. Self-hosted and connected servers, free trials, and features designated as preview or beta are outside this SLA.",
        ),
        copy(
          "Downtime is a period when a failure of OpenShip-managed compute, storage, networking, routing, or control-plane services prevents your Cloud Space from running or serving otherwise working workloads, or prevents deployment and lifecycle operations such as starting or restarting workloads. A cosmetic dashboard issue alone is not downtime when those operations and workloads remain available.",
        ),
        copy(
          "We measure uptime for each Cloud Space in each UTC calendar month. The percentage is 100 × (eligible minutes − downtime minutes) ÷ eligible minutes. Eligible minutes are the minutes when your paid subscription and this SLA were in effect. We remove excluded periods from both totals and count overlapping incidents once. If your plan changes, we assess the time covered by each guarantee separately. We use the unrounded percentage to determine your credit.",
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
          "When a Cloud Space misses its monthly uptime guarantee, you qualify for a service credit based on the verified uptime.",
        ),
        ...CLOUD_SLA.creditTiers.map(({ minimumUptimePercent, creditPercent }, index) => {
          const upper = CLOUD_SLA.creditTiers[index - 1]?.minimumUptimePercent;
          const values = { minimum: minimumUptimePercent, credit: creditPercent };
          if (upper === undefined)
            return copy(
              "A {credit}% credit applies from {minimum}% uptime to below the plan’s guarantee.",
              values,
            );
          if (minimumUptimePercent === 0)
            return copy("A {credit}% credit applies below {maximum}% uptime.", {
              maximum: upper,
              credit: creditPercent,
            });
          return copy(
            "A {credit}% credit applies from {minimum}% to less than {maximum}% uptime.",
            { ...values, maximum: upper },
          );
        }),
        copy(
          "Credits are based on the fees paid for the affected Cloud Space after discounts, excluding taxes, usage add-ons and separately billed services. For annual subscriptions, the monthly fee is one twelfth of the annual fee. We prorate fees for partial months and plan changes.",
        ),
        copy(
          "Each part of the month is eligible for one credit tier. We combine covered incidents before calculating uptime. Total SLA credits are capped at the affected Cloud Space’s applicable monthly fee.",
        ),
        copy(
          "We apply approved service credits within {value0} days of approval. Credits offset your next eligible OpenShip Cloud subscription invoice, including an annual renewal.",
          { value0: String(CLOUD_SLA.creditIssueDays) },
        ),
        copy(
          "If you cancel the affected subscription and no eligible future invoice remains, you may request a refund of the unused approved credit. We refund it to the original payment method, up to the fees you paid for the affected period. Any credit applied or refund already paid for the same downtime counts toward that amount. Your rights under applicable law and any separate written agreement still apply.",
        ),
        copy(
          "We may issue credits proactively when we can verify the impact. We may also offer a goodwill credit for a significant disruption even when the monthly guarantee is met.",
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
          "We review our monitoring and incident records alongside any information you provide. Once we have the information we need, we’ll send our decision, the uptime calculation, and any approved credit amount within {value0} business days.",
          { value0: String(CLOUD_SLA.claimReviewBusinessDays) },
        ),
      ],
    },
  ];
}
