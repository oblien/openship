import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import type { ReactNode } from "react";
import { CURRENCY_LD, getCloudPricing, priceLd, type CloudPricing } from "@/lib/pricing";
import { faq } from "./_data";

const PAGE_URL = "https://openship.io/pricing";
export const revalidate = 60;
const DESCRIPTION =
  "Compare Openship Cloud managed servers. Monthly or yearly CPU, RAM and storage for your projects, with clear resource limits and no per-seat fees.";
const metadata: Metadata = {
  title: "Pricing",
  description: DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing - Openship",
    description: DESCRIPTION,
    url: "/pricing",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "Pricing - Openship", description: DESCRIPTION },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return inheritSocialImages(metadata, parent);
}

function buildLd(pricing: CloudPricing) {
  const offers = pricing.tiers.map((plan) => ({
    "@type": "Offer",
    name: `Openship Cloud ${plan.name}`,
    description: plan.description,
    price: priceLd(plan.price.monthly),
    priceCurrency: CURRENCY_LD,
    url: PAGE_URL,
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: priceLd(plan.price.monthly),
      priceCurrency: CURRENCY_LD,
      billingDuration: 1,
      billingIncrement: 1,
      unitCode: "MON",
    },
  }));
  return [
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faq(pricing).map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    },
    {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Openship Cloud",
      description: DESCRIPTION,
      brand: { "@type": "Brand", name: "Openship" },
      category: "Software / Developer Tools",
      ...(offers.length
        ? {
            offers: {
              "@type": "AggregateOffer",
              priceCurrency: CURRENCY_LD,
              lowPrice: priceLd(Math.min(...pricing.tiers.map((plan) => plan.price.monthly))),
              highPrice: priceLd(Math.max(0, ...pricing.tiers.map((plan) => plan.price.monthly))),
              offerCount: offers.length,
              url: PAGE_URL,
              offers,
            },
          }
        : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://openship.io" },
        { "@type": "ListItem", position: 2, name: "Pricing", item: PAGE_URL },
      ],
    },
  ];
}

export default async function PricingLayout({ children }: { children: ReactNode }) {
  const pricing = await getCloudPricing();
  return (
    <>
      {buildLd(pricing).map((data, index) => (
        <script
          key={index}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
        />
      ))}
      {children}
    </>
  );
}
