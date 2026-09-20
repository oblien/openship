import { UI, paidLadder, type CloudPricing } from "@/lib/pricing";

export interface FaqItem {
  q: string;
  a: string;
}

export function faq(pricing: CloudPricing): FaqItem[] {
  const ladder = paidLadder(pricing);

  return [
    {
      q: "Is self-hosting really free?",
      a: "Yes — free forever. Run the full platform on your own servers with no metering, no seat caps, and no telemetry. It's open source under Apache 2.0, and there's nothing to buy or sign up for: install the CLI, point it at a box, and you're running.",
    },
    {
      q: "How much does Openship Cloud cost?",
      a: [
        pricing.freeTier ? `The ${pricing.freeTier.name} tier costs nothing.` : null,
        ladder ? `Paid plans are ${ladder}, ${UI.billedMonthly}.` : null,
        !pricing.available ? "See your dashboard for current Cloud plans and availability." : null,
        pricing.customTiers.length > 0
          ? `${pricing.customTiers.map((p) => p.name).join(" and ")} is priced per contract — talk to sales.`
          : null,
        "Plans are billed per organization. The checkout shows the final amount before payment.",
      ]
        .filter((s): s is string => s !== null)
        .join(" "),
    },
    {
      q: "Can I move between self-hosted and cloud later?",
      a: "Yes, either direction. Your containers travel as-is — no rebuild, no rewrites — because a deployment on Openship is a plain image and standard manifests. Move a workload from Cloud onto your own box, or the other way, without paying an exit tax.",
    },
    {
      q: "What's the license?",
      a: "Apache 2.0 — a permissive license. Use it, modify it, fork it, and ship it in commercial or closed-source products, no strings attached. Run it in your cloud, on a Raspberry Pi, or in production for a SaaS.",
    },
    {
      q: "Do you store my source code?",
      a: "Only what's needed to build. We never store unencrypted secrets, and source is fetched fresh from your repo for each build. Self-hosted keeps everything on your infrastructure by definition.",
    },
  ];
}

/** Where a Cloud plan's CTA goes. The marketing site has no signup route of its
 *  own; `/login` redirects to the app, same as the navbar. */
export const CLOUD_CTA_HREF = "/login";
export const SELF_HOST_CTA_HREF = "/docs/getting-started/quickstart";
