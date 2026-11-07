import type { Metadata, ResolvingMetadata } from "next";
import type { ReactNode } from "react";
import { inheritSocialImages } from "@/lib/social-metadata";
import { cloudFrom, getCloudPricing } from "@/lib/pricing";
import { faq } from "./_data";

const PAGE_URL = "https://openship.io/migrate";
export const revalidate = 60;
const TITLE = "Move your app to Openship";
const DESCRIPTION =
  "Hosting bill growing with your traffic? App hitting memory limits, or split across three services? Openship Cloud runs your whole app as it is, on a server with fixed resources.";

const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/migrate" },
  openGraph: {
    title: `${TITLE} - Openship`,
    description: DESCRIPTION,
    url: "/migrate",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: `${TITLE} - Openship`, description: DESCRIPTION },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return inheritSocialImages(metadata, parent);
}

export default async function MigrateLayout({ children }: { children: ReactNode }) {
  const from = cloudFrom(await getCloudPricing());
  const ld = [
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faq(from).map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://openship.io" },
        { "@type": "ListItem", position: 2, name: "Migrate", item: PAGE_URL },
      ],
    },
  ];
  return (
    <>
      {ld.map((data, index) => (
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
