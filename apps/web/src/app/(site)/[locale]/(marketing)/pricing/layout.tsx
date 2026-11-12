import type { Copy } from "@/i18n/copy";
import { getLocale } from "next-intl/server";
import { localizedMetadata } from "@/i18n/metadata";

import { getCopy } from "@/i18n/copy-server";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  CURRENCY_LD,
  cloudPlanSummary,
  getCloudPricing,
  priceLd,
  type CloudPricing,
} from "@/lib/pricing";
import { faq } from "./_data";
import { CLOUD_SLA } from "@/lib/cloud-service";

const PAGE_URL = "https://openship.io/pricing";
export const revalidate = 60;
const DESCRIPTION = `Compare OpenShip Cloud resource pools for your projects. Shared CPU, RAM and storage, support included, and a ${CLOUD_SLA.monthlyUptimePercent}% monthly uptime guarantee on every plan.`;
const pageMetadata: Metadata = {
  title: "Pricing",
  description: DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing - OpenShip",
    description: DESCRIPTION,
    url: "/pricing",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "Pricing - OpenShip", description: DESCRIPTION },
};

function buildLd(pricing: CloudPricing, copy: Copy) {
  const offers = pricing.tiers.map((plan) => ({
    "@type": "Offer",
    name: `OpenShip Cloud ${plan.name}`,
    description: cloudPlanSummary(plan, copy),
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
      mainEntity: faq(pricing, copy).map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    },
    {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "OpenShip Cloud",
      description: DESCRIPTION,
      brand: { "@type": "Brand", name: "OpenShip" },
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
  const copy = await getCopy();

  const pricing = await getCloudPricing(await getLocale());
  return (
    <>
      {buildLd(pricing, copy).map((data, index) => (
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

export async function generateMetadata() {
  const copy = await getCopy();
  const description = copy(
    "Compare OpenShip Cloud resource pools for your projects. Shared CPU, RAM and storage, support included, and a {uptime}% monthly uptime guarantee on every plan.",
    { uptime: CLOUD_SLA.monthlyUptimePercent },
  );
  return localizedMetadata({
    ...pageMetadata,
    description,
    openGraph: { ...pageMetadata.openGraph, description },
    twitter: { ...pageMetadata.twitter, description },
  });
}
