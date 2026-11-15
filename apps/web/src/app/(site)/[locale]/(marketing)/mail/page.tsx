import { localizedMetadata } from "@/i18n/metadata";

import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import { Navbar } from "@/components/landing";
import HomeContent from "./_components/home/HomeContent";

const TITLE = "Mail — Your email control panel";
const DESCRIPTION =
  "Manage domains, mailboxes, aliases, delivery, and backups on your own mail server with OpenShip. Connect existing mailboxes through webmail on Cloud.";

const metadata: Metadata = {
  title: "Mail",
  description: DESCRIPTION,
  alternates: { canonical: "/mail" },
  keywords: [
    "self-hosted email",
    "transactional email",
    "open source SMTP",
    "team email",
    "unlimited mailboxes",
    "custom domain email",
    "self host mail server",
    "Mailgun alternative",
    "SendGrid alternative",
    "Postmark alternative",
  ],
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/mail",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return localizedMetadata(await inheritSocialImages(metadata, parent));
}

const serviceLd = {
  "@context": "https://schema.org",
  "@type": "Service",
  name: "OpenShip Mail",
  serviceType: "Email Hosting",
  provider: {
    "@type": "Organization",
    name: "OpenShip",
    url: "https://openship.io",
  },
  description: DESCRIPTION,
  url: "https://openship.io/mail",
  areaServed: "Worldwide",
  audience: {
    "@type": "Audience",
    audienceType: "Developers, SaaS teams, agencies",
  },
};

const breadcrumbLd = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: "https://openship.io" },
    { "@type": "ListItem", position: 2, name: "Mail", item: "https://openship.io/mail" },
  ],
};

export default function MailLandingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(serviceLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />
      <Navbar />
      <HomeContent />
    </>
  );
}
