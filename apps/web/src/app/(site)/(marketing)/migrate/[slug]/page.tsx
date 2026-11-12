import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { CLOUD_DASHBOARD_URL } from "@repo/core";
import { AppLogo } from "@repo/ui/app-logo";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { Navbar, Footer } from "@/components/landing";
import { MarketingIntro } from "@/components/marketing/marketing-intro";
import { MarketingSection } from "@/components/marketing/marketing-section";
import { MarketingCta } from "@/components/marketing/marketing-cta";
import { MIGRATION_SOURCES, getMigrationSource } from "@/lib/migration-sources";
import { MigrationFaq } from "../_components/migration-faq";
import { MigrationSteps } from "../_components/migration-steps";
import "../migrate.css";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return MIGRATION_SOURCES.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const source = getMigrationSource((await params).slug);
  if (!source) notFound();
  const title = `Migrate from ${source.name} to Openship`;
  const url = `/migrate/${source.slug}`;
  return {
    title: { absolute: title },
    description: source.description,
    alternates: { canonical: url },
    openGraph: { title, description: source.description, url, type: "website" },
    twitter: { card: "summary_large_image", title, description: source.description },
  };
}

export default async function MigrationSourcePage({ params }: Props) {
  const source = getMigrationSource((await params).slug);
  if (!source) notFound();
  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <MarketingIntro
          eyebrow={
            <span className="mg-provider-label">
              <span className="mg-provider-logos" aria-hidden="true">
                {source.logos.map((logo) => (
                  <AppLogo
                    key={logo}
                    slug={logo}
                    src={`/provider-logos/${logo}.svg`}
                    className="size-6"
                    invertOnDark={false}
                  />
                ))}
              </span>
              <span className="mg-provider-caption">
                Migrate from <span>{source.name}</span>
              </span>
            </span>
          }
          title={
            <>
              {source.headline}
              <br />
              <span>A new home.</span>
            </>
          }
          description={source.description}
        >
          <div className="mg-intro-actions">
            <a
              href={new URL("/library", CLOUD_DASHBOARD_URL).toString()}
              className="th-btn mg-import-action"
            >
              Start your import <ArrowRight size={16} aria-hidden="true" />
            </a>
            <Link href={source.guide} className="marketing-text-link">
              Read the guide <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </MarketingIntro>
        {source.screenshot && (
          <figure className="site-container mg-screenshot">
            <Image
              src={source.screenshot.image}
              alt={source.screenshot.alt}
              sizes="(max-width: 1280px) 100vw, 1280px"
            />
            <figcaption>{source.screenshot.caption}</figcaption>
          </figure>
        )}
        <div className="site-container marketing-content">
          <MarketingSection
            id="what-moves"
            title="What comes with you"
            description="Review your application, its configuration and its data in one import."
          >
            <div className="marketing-grid">
              {source.highlights.map((item) => (
                <div className="mg-capability" key={item.title}>
                  <FeatureIllustration
                    name={item.illustration}
                    className="marketing-illustration"
                  />
                  <div className="marketing-link-copy">
                    <h3>{item.title}</h3>
                    <p>{item.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </MarketingSection>
          <MarketingSection
            id="how-it-works"
            title="From connection to cutover"
            description="Start in New project → Import existing project. Review before anything moves."
          >
            <MigrationSteps steps={source.steps} />
          </MarketingSection>
          <MarketingSection
            id="data"
            title={source.dataTitle}
            description="Plan the transfer around the data your application needs to keep."
          >
            <div className="marketing-prose">
              {source.data.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <Link href="/support" className="marketing-text-link">
                Talk through your migration <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </MarketingSection>
          <MarketingSection
            id="faq"
            title="Before you move"
            description="Access, compatibility and the final switch."
          >
            <MigrationFaq items={source.questions} />
          </MarketingSection>
          <Link href="/migrate" className="marketing-text-link mg-all-sources">
            Explore all migration options <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
        <MarketingCta />
      </main>
      <Footer />
    </>
  );
}
