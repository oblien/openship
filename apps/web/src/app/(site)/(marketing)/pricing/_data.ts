import { CUSTOM_TIERS, FREE_TIER, UI, liveCampaigns, paidLadder } from "@/lib/pricing";

/**
 * `/pricing`-specific copy. Every number comes from `@/lib/pricing`, which
 * resolves the `@repo/core` catalog — nothing here restates a price.
 *
 * The page and its JSON-LD both call `faq(now)` with the SAME instant (see
 * `renderNow`), so the answers Google indexes are byte-identical to the answers
 * a reader sees — including the prices, which move when a campaign is live.
 *
 * That is also why this is a function rather than the module const it used to
 * be: a const holding a campaign price would be evaluated once per process and
 * could never expire.
 */
export interface FaqItem {
  q: string;
  a: string;
}

export function faq(now: Date): FaqItem[] {
  const ladder = paidLadder(now);
  const campaigns = liveCampaigns(now);

  return [
    {
      q: "Is self-hosting really free?",
      a: "Yes — free forever. Run the full platform on your own servers with no metering, no seat caps, and no telemetry. It's open source under Apache 2.0, and there's nothing to buy or sign up for: install the CLI, point it at a box, and you're running.",
    },
    {
      q: "How much does Openship Cloud cost?",
      a: [
        FREE_TIER ? `The ${FREE_TIER.name} tier costs nothing.` : null,
        ladder ? `Paid plans are ${ladder}, ${UI.billedMonthly}.` : null,
        // Quoting discounted prices without saying they are an offer would
        // misrepresent the regular price, so the campaign is named here too.
        // `endsDate` (not `ends`) because this sits mid-sentence and lowercasing
        // the ready-made "Offer ends …" line would mangle the month name.
        campaigns.length > 0
          ? `Those prices include our current offer — ${campaigns
              .map((c) => `${c.badge} until ${c.endsDate}`)
              .join("; ")}.`
          : null,
        CUSTOM_TIERS.length > 0
          ? `${CUSTOM_TIERS.map((p) => p.name).join(" and ")} is priced per contract — talk to sales.`
          : null,
        "Every plan includes unlimited team members, so the price you see covers your whole organization.",
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
