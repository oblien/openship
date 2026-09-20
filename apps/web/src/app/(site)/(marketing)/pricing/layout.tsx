import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CURRENCY_LD, SELF_HOSTED, getCloudPricing, priceLd, type CloudPricing } from "@/lib/pricing";
import { faq } from "./_data";

const PAGE_URL = "https://openship.io/pricing";
export const revalidate = 60;
const DESCRIPTION = "Openship pricing: free, open source self-hosting and managed Cloud plans for your organization.";
export const metadata: Metadata = {
  title: "Pricing", description: DESCRIPTION, alternates: { canonical: "/pricing" },
  openGraph: { title: "Pricing - Openship", description: DESCRIPTION, url: "/pricing", type: "website" },
  twitter: { card: "summary_large_image", title: "Pricing - Openship", description: DESCRIPTION },
};

function buildLd(pricing: CloudPricing) {
  const offers = [
    { "@type": "Offer", name: SELF_HOSTED.name, price: priceLd(0), priceCurrency: CURRENCY_LD, url: PAGE_URL },
    ...pricing.tiers.map((plan) => ({
      "@type": "Offer", name: `Openship Cloud ${plan.name}`, description: plan.description,
      price: priceLd(plan.price.monthly), priceCurrency: CURRENCY_LD, url: PAGE_URL,
      priceSpecification: { "@type": "UnitPriceSpecification", price: priceLd(plan.price.monthly),
        priceCurrency: CURRENCY_LD, billingDuration: 1, billingIncrement: 1, unitCode: "MON" },
    })),
  ];
  return [
    {
      "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: faq(pricing).map((item) => ({ "@type": "Question", name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a } })),
    },
    {
      "@context": "https://schema.org", "@type": "Product", name: "Openship", description: DESCRIPTION,
      brand: { "@type": "Brand", name: "Openship" }, category: "Software / Developer Tools",
      offers: { "@type": "AggregateOffer", priceCurrency: CURRENCY_LD, lowPrice: priceLd(0),
        highPrice: priceLd(Math.max(0, ...pricing.tiers.map((plan) => plan.price.monthly))),
        offerCount: offers.length, url: PAGE_URL, offers },
    },
    {
      "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://openship.io" },
        { "@type": "ListItem", position: 2, name: "Pricing", item: PAGE_URL },
      ],
    },
  ];
}

export default async function PricingLayout({ children }: { children: ReactNode }) {
  const pricing = await getCloudPricing();
  return <>
    {buildLd(pricing).map((data, index) => <script key={index} type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />)}
    {children}
  </>;
}
