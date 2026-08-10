import {
  Navbar,
  Hero,
  Dashboard,
  SystemMap,
  HowItWorks,
  DeploymentModels,
  CompletePlatform,
  MailServer,
  Comparison,
  OpenSource,
  FinalCta,
  Footer,
} from "@/components/landing";

const SITE_URL = "https://openship.io";

const softwareLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Openship",
  applicationCategory: "DeveloperApplication",
  applicationSubCategory: "Deployment Platform",
  operatingSystem: "macOS, Windows, Linux, Web",
  url: SITE_URL,
  downloadUrl: `${SITE_URL}/download`,
  softwareVersion: "latest",
  publisher: {
    "@type": "Organization",
    name: "Openship",
    url: SITE_URL,
  },
  description:
    "Open source, self-hostable deployment platform with AI-powered builds, free SSL, instant rollbacks, unlimited domains, and CLI/MCP support.",
  license: "https://www.apache.org/licenses/LICENSE-2.0",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  },
  featureList: [
    "AI-powered builds",
    "Free SSL certificates",
    "Unlimited domains",
    "Instant rollback",
    "CLI deploys",
    "MCP server integration",
    "Self-hostable",
    "Multi-region edge",
    "Managed Postgres / Redis / Mail",
    "Zero-downtime deploys",
  ],
};

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareLd) }}
      />
      <Navbar />
      <main>
        <Hero />
        <Dashboard />
        <SystemMap />
        <HowItWorks />
        <DeploymentModels />
        <CompletePlatform />
        <MailServer />
        <Comparison />
        <OpenSource />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
