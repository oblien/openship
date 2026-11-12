import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AppLogo } from "@repo/ui/app-logo";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { Navbar, Footer, Comparison } from "@/components/landing";
import { MarketingIntro } from "@/components/marketing/marketing-intro";
import { MarketingSection } from "@/components/marketing/marketing-section";
import { IllustratedLink } from "@/components/marketing/illustrated-link";
import { cloudFrom, getCloudPricing } from "@/lib/pricing";
import { cloudPlanHref } from "@/lib/cloud-links";
import { MIGRATION_SOURCES } from "@/lib/migration-sources";
import { MigrationFaq } from "./_components/migration-faq";
import { MigrationSteps } from "./_components/migration-steps";
import { STARTING_POINTS, REASONS, STEPS, faq } from "./_data";
import "./migrate.css";

export const revalidate = 60;

const TITLE = "Move your app to Openship";
const DESCRIPTION =
  "Migrate from Railway, Vercel, Coolify, Dokploy or a Docker server to Openship. Review services and data, deploy to Cloud or your own infrastructure, then switch your domains.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/migrate" },
  openGraph: {
    title: `${TITLE} - Openship`,
    description: DESCRIPTION,
    url: "/migrate",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${TITLE} - Openship`,
    description: DESCRIPTION,
  },
};

export default async function MigratePage() {
  const from = cloudFrom(await getCloudPricing());
  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <MarketingIntro
          eyebrow="Move to Openship"
          title={
            <>
              Bring your app.
              <br />
              <span>Keep your stack.</span>
            </>
          }
          description="Import from Railway, Vercel or an existing Docker server. Bring your repository or Compose stack. Move to Openship Cloud or manage your own infrastructure."
        >
          <Link href="/support" className="marketing-text-link mg-intro-link">
            Talk through your migration <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </MarketingIntro>
        <div className="site-container marketing-content">
          <MarketingSection
            id="platforms"
            title="Move from your platform"
            description="See what transfers, how data moves and what to prepare."
          >
            <div className="marketing-grid">
              {MIGRATION_SOURCES.map((source) => (
                <Link
                  key={source.slug}
                  href={`/migrate/${source.slug}`}
                  className="mg-provider-link"
                >
                  <span className="mg-provider-logos" aria-hidden="true">
                    {source.logos.map((logo) => (
                      <AppLogo
                        key={logo}
                        slug={logo}
                        src={`/provider-logos/${logo}.svg`}
                        className="size-9"
                        invertOnDark={false}
                      />
                    ))}
                  </span>
                  <div>
                    <h3>From {source.name}</h3>
                    <p>{source.summary}</p>
                  </div>
                  <ArrowRight size={16} aria-hidden="true" />
                </Link>
              ))}
            </div>
          </MarketingSection>
          <MarketingSection
            id="start"
            title="Start with what you have"
            description="Choose the guide that matches how your app runs today."
          >
            <div className="marketing-grid">
              {STARTING_POINTS.map((item) => (
                <IllustratedLink key={item.title} {...item} />
              ))}
            </div>
          </MarketingSection>
          <MarketingSection
            id="steps"
            title="Plan the move"
            description="Prepare the destination, verify the app, then switch traffic."
          >
            <MigrationSteps steps={STEPS} />
          </MarketingSection>
          <MarketingSection
            id="destination"
            title="Choose where it runs"
            description="The same deployment tools, with a hosting model that fits your team."
          >
            <div className="mg-destinations">
              <div className="mg-destination">
                <FeatureIllustration name="deploy-anywhere" className="marketing-illustration" />
                <h3>Openship Cloud</h3>
                <p>
                  A managed resource pool for your projects. Apps, builds, and data share your
                  plan’s capacity.
                </p>
                <span className="mg-price">
                  {from ? `From ${from}/month` : "Explore Cloud plans"}
                </span>
                <a href={cloudPlanHref()} className="th-btn mg-destination-action">
                  Start on Cloud <ArrowRight size={16} aria-hidden="true" />
                </a>
              </div>
              <div className="mg-destination">
                <FeatureIllustration name="server-management" className="marketing-illustration" />
                <h3>Your infrastructure</h3>
                <p>Connect your servers and manage deployments, data, and domains from Openship.</p>
                <span className="mg-price">Free to self-host</span>
                <Link
                  href="/docs/getting-started/installation"
                  className="marketing-text-link mg-destination-action"
                >
                  Set up Openship <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </div>
            </div>
          </MarketingSection>
          <MarketingSection
            id="situations"
            title="What changes"
            description="More of your stack in one place, with control over where it lives."
          >
            <div className="marketing-grid">
              {REASONS.map((item) => (
                <IllustratedLink key={item.id} {...item} />
              ))}
            </div>
          </MarketingSection>
          <MarketingSection
            id="faq"
            title="Before you move"
            description="The practical details, from compatibility to cutover."
          >
            <MigrationFaq items={faq(from)} />
          </MarketingSection>
        </div>
        <Comparison />
      </main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Home", item: "https://openship.io" },
              {
                "@type": "ListItem",
                position: 2,
                name: "Migrate",
                item: "https://openship.io/migrate",
              },
            ],
          }),
        }}
      />
      <Footer />
    </>
  );
}
