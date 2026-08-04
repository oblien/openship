import {
  Navbar,
  Hero,
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

/** How many numbered sections the page carries, for the `[n/N]` counters. */
const SECTION_COUNT = 7;

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
      {/* Section order mirrors the argument, not the org chart: what the
          platform is, how it is put together, how you use it, how it
          compares, what comes included, where it runs, and who owns it.
          The counters are numbered here because ordering is the page's
          decision - no section should have to know its own position. */}
      <main className="lp-ruled">
        <Hero />
        <CompletePlatform index={1} total={SECTION_COUNT} />
        <SystemMap index={2} total={SECTION_COUNT} />
        <HowItWorks index={3} total={SECTION_COUNT} />
        <Comparison index={4} total={SECTION_COUNT} />
        <MailServer index={5} total={SECTION_COUNT} />
        <DeploymentModels index={6} total={SECTION_COUNT} />
        <OpenSource index={7} total={SECTION_COUNT} />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
