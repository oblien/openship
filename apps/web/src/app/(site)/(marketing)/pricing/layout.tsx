import type { Metadata } from "next";
import type { ReactNode } from "react";

const TITLE = "Pricing";
const DESCRIPTION =
  "Openship pricing - Hobby is free forever, self-hosted. Cloud is $20 per seat per month, fully managed. Business is custom with SSO, SLA, and dedicated support.";

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

const faqLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "Is there a free trial?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Cloud is free to start - sign up, deploy, no credit card. You only enter billing once you exceed the free allowances on compute and bandwidth. Hobby is free forever on your own servers.",
      },
    },
    {
      "@type": "Question",
      name: "How does the per-seat pricing work?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Cloud is $20 per active team member per month, billed monthly, or $16 effective with annual billing. Projects, deploys, domains, and managed services are not metered per seat.",
      },
    },
    {
      "@type": "Question",
      name: "Can I move between plans?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. Cloud ⇄ Hobby in one click - your containers travel as-is, no rebuild, no rewrites. Cloud ⇄ Business is a one-line config change.",
      },
    },
    {
      "@type": "Question",
      name: "What counts as compute usage on Cloud?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "CPU-seconds and memory-seconds your running containers consume. Idle services that auto-scale to zero cost nothing. We bill in arrears with a clear monthly breakdown.",
      },
    },
    {
      "@type": "Question",
      name: "Do you charge for bandwidth?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Cloud includes 100 GB of egress per project per month. Overage is billed at $0.05 per GB, capped - and edge cache hits don't count.",
      },
    },
    {
      "@type": "Question",
      name: "What's the license for Hobby?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "AGPL-3.0. The platform stays open for everyone who deploys with it. You can run it in your cloud, on a Raspberry Pi, or in production for a SaaS - no commercial restrictions.",
      },
    },
    {
      "@type": "Question",
      name: "Do you store my source code?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Only what's needed to build. We never store unencrypted secrets, and source is fetched fresh from your repo for each build. Self-hosted keeps everything on your infrastructure by definition.",
      },
    },
  ],
};

const productLd = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Openship",
  description:
    "Open source, self-hostable deployment platform with AI-powered builds, free SSL, instant rollbacks, and CLI/MCP support.",
  brand: { "@type": "Brand", name: "Openship" },
  category: "Software / Developer Tools",
  offers: [
    {
      "@type": "Offer",
      name: "Hobby",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      description: "Self-hosted, AGPL-3. Free forever on your own servers.",
      url: "https://openship.io/pricing",
    },
    {
      "@type": "Offer",
      name: "Cloud",
      price: "20",
      priceCurrency: "USD",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: "20",
        priceCurrency: "USD",
        unitText: "per seat per month",
      },
      availability: "https://schema.org/InStock",
      description: "Managed multi-region cloud with auto-scaling and backups.",
      url: "https://openship.io/pricing",
    },
    {
      "@type": "Offer",
      name: "Business",
      priceSpecification: {
        "@type": "PriceSpecification",
        priceCurrency: "USD",
        price: "0",
        valueAddedTaxIncluded: false,
      },
      availability: "https://schema.org/InStock",
      description:
        "Hybrid cloud + self-hosted with SSO, audit logs, SLA, and dedicated support.",
      url: "https://openship.io/pricing",
    },
  ],
};

const breadcrumbLd = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: "https://openship.io" },
    { "@type": "ListItem", position: 2, name: "Pricing", item: "https://openship.io/pricing" },
  ],
};

export default function PricingLayout({ children }: { children: ReactNode }) {
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
