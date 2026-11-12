import { localizedMetadata } from "@/i18n/metadata";

import type { Metadata } from "next";
import type { ReactNode } from "react";

const TITLE = "Download";
const DESCRIPTION =
  "Install OpenShip on macOS, Windows, Linux, or grab the CLI. Native desktop app and command-line - same backend, same deploys, your choice of surface.";

const pageMetadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/download" },
  keywords: [
    "openship download",
    "openship CLI",
    "openship desktop",
    "deploy CLI",
    "macOS deploy tool",
    "Windows deploy tool",
    "Linux deploy tool",
    "self host CLI",
  ],
  openGraph: {
    title: `${TITLE} - OpenShip`,
    description: DESCRIPTION,
    url: "/download",
    type: "website",
    siteName: "OpenShip",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: `${TITLE} - OpenShip`,
    description: DESCRIPTION,
  },
};

const softwareLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "OpenShip",
  applicationCategory: "DeveloperApplication",
  applicationSubCategory: "Deployment Platform",
  operatingSystem: "macOS, Windows, Linux",
  url: "https://openship.io/download",
  downloadUrl: "https://openship.io/download",
  softwareVersion: "latest",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  publisher: {
    "@type": "Organization",
    name: "OpenShip",
    url: "https://openship.io",
  },
  description: DESCRIPTION,
  license: "https://www.apache.org/licenses/LICENSE-2.0",
};

const breadcrumbLd = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: "https://openship.io" },
    { "@type": "ListItem", position: 2, name: "Download", item: "https://openship.io/download" },
  ],
};

export default function DownloadLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />
      {children}
    </>
  );
}

export async function generateMetadata() {
  return localizedMetadata(pageMetadata);
}
