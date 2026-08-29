import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  CLOUD_FROM_LIST,
  CURRENCY_LD,
  CUSTOM_TIERS,
  SELF_HOSTED,
  TIERS,
  planPricing,
  priceLd,
  renderNow,
} from "@/lib/pricing";
import { faq } from "./_data";

const PAGE_URL = "https://openship.io/pricing";

/**
 * Same reasoning as the page: the Offers below carry a campaign price, so they
 * must be built during the render, not in a module const that freezes at build.
 * Declared here as well as on the page so the window applies no matter which of
 * the two a future edit touches — and it MUST match the page's, or the structured
 * data could be revalidated on a different beat than the price a reader sees.
 */
export const revalidate = 60;

const TITLE = "Pricing";

/**
 * The metadata description deliberately quotes the LIST price, not a campaign
 * price. A search snippet is cached by the engine for days or weeks, so a
 * discount published here would outlive the offer and advertise a price we no
 * longer honour. The JSON-LD Offer below does the opposite — Google requires the
 * structured price to match the visible page, and it is re-crawled, not
 * snapshotted into a snippet.
 */
const DESCRIPTION = [
  "Openship pricing - self-hosted is free forever and open source (Apache 2.0).",
  CLOUD_FROM_LIST
    ? `Managed Openship Cloud starts free and paid plans begin at ${CLOUD_FROM_LIST} a month.`
    : null,
  "Unlimited team members on every plan.",
]
  .filter((s): s is string => s !== null)
  .join(" ");

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: `${TITLE} - Openship`,
    description: DESCRIPTION,
    url: "/pricing",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${TITLE} - Openship`,
    description: DESCRIPTION,
  },
};

/** Schema.org `priceValidUntil` wants a date, not an instant. */
function validUntil(endsAt: string): string {
  return new Date(endsAt).toISOString().slice(0, 10);
}

/**
 * Structured data, built for ONE instant.
 *
 * `now` comes from `renderNow()`, the same per-render value the page uses, so the
 * price in the markup and the price on screen cannot disagree — including at the
 * moment a campaign expires.
 *
 * While a campaign is live an Offer emits the EFFECTIVE price as `price` (that is
 * what a buyer pays today), carries the list price as a second
 * `UnitPriceSpecification` tagged `ListPrice`, and states `priceValidUntil` so a
 * crawler knows the number has an expiry.
 */
function buildLd(now: Date) {
  /* The FAQ markup must mirror the FAQ a reader sees, so both read `_data`. */
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq(now).map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  /* Self-hosted is free forever; Cloud tiers carry their catalog price. Tiers
     priced per contract are quoted in the description instead of being given an
     invented number. */
  const tierOffers = [
    {
      "@type": "Offer",
      name: SELF_HOSTED.name,
      description: `${SELF_HOSTED.tagline} ${SELF_HOSTED.priceNote}`,
      price: priceLd(0),
      priceCurrency: CURRENCY_LD,
      availability: "https://schema.org/InStock",
      url: PAGE_URL,
    },
    ...TIERS.map((plan) => {
      const { listCents, effectiveCents, campaign, discounted } = planPricing(plan, now);
      // `TIERS` is already narrowed to a published monthly price, so the
      // fallbacks here are unreachable — they exist so no `!` assertion can
      // quietly emit a `0` for a tier that has no price.
      const charged = effectiveCents ?? plan.price.monthly;
      const list = listCents ?? plan.price.monthly;

      const recurring = {
        "@type": "UnitPriceSpecification",
        price: priceLd(charged),
        priceCurrency: CURRENCY_LD,
        billingDuration: 1,
        billingIncrement: 1,
        unitCode: "MON",
      };
      // A bare object while there is no campaign — the shape that has been
      // indexed all along — and only an array when there is a second, ListPrice
      // spec to carry.
      const priceSpecification = discounted
        ? [
            recurring,
            {
              "@type": "UnitPriceSpecification",
              priceType: "https://schema.org/ListPrice",
              price: priceLd(list),
              priceCurrency: CURRENCY_LD,
              billingDuration: 1,
              billingIncrement: 1,
              unitCode: "MON",
            },
          ]
        : recurring;

      return {
        "@type": "Offer",
        name: `Openship Cloud ${plan.name}`,
        description: plan.description,
        price: priceLd(charged),
        priceCurrency: CURRENCY_LD,
        availability: "https://schema.org/InStock",
        url: PAGE_URL,
        ...(discounted && campaign ? { priceValidUntil: validUntil(campaign.endsAt) } : {}),
        ...(charged > 0 || list > 0 ? { priceSpecification } : {}),
      };
    }),
  ];

  /* The prices actually emitted above — the leading 0 is the self-hosted offer. */
  const offerCents = [
    0,
    ...TIERS.map((p) => planPricing(p, now).effectiveCents ?? p.price.monthly),
  ];

  const productLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Openship",
    description: [
      "Open source, self-hostable deployment platform with AI-powered builds, free SSL, instant rollbacks, and CLI/MCP support.",
      "Free forever on your own servers; Openship Cloud is the managed option.",
      CUSTOM_TIERS.length > 0
        ? `${CUSTOM_TIERS.map((p) => p.name).join(" and ")} pricing is negotiated per contract.`
        : null,
    ]
      .filter((s): s is string => s !== null)
      .join(" "),
    brand: { "@type": "Brand", name: "Openship" },
    category: "Software / Developer Tools",
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: CURRENCY_LD,
      lowPrice: priceLd(Math.min(...offerCents)),
      highPrice: priceLd(Math.max(...offerCents)),
      offerCount: tierOffers.length,
      availability: "https://schema.org/InStock",
      url: PAGE_URL,
      offers: tierOffers,
    },
  };

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://openship.io" },
      { "@type": "ListItem", position: 2, name: "Pricing", item: PAGE_URL },
    ],
  };

  return { faqLd, productLd, breadcrumbLd };
}

export default function PricingLayout({ children }: { children: ReactNode }) {
  const { faqLd, productLd, breadcrumbLd } = buildLd(renderNow());

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />
      {children}
    </>
  );
}
