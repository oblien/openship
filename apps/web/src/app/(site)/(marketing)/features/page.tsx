import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import Link from "next/link";
import { Navbar, Footer } from "@/components/landing";
import { FEATURES, CATEGORY_ORDER, CATEGORY_BLURB, categoryId } from "./_data";
import { FeatureLink } from "./_components/FeatureLink";
import { MarketingCta } from "@/components/marketing/marketing-cta";
import { MarketingIntro } from "@/components/marketing/marketing-intro";
import { MarketingSection } from "@/components/marketing/marketing-section";
import "./features.css";

const PAGE_TITLE = "Features";
const PAGE_DESCRIPTION =
  "Explore Openship's deployment, CI, runners, apps, backups, migration, networking, monitoring, and team access features, with detailed guides and availability.";

const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/features" },
  openGraph: {
    title: `${PAGE_TITLE} — Openship`,
    description: PAGE_DESCRIPTION,
    url: "/features",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${PAGE_TITLE} — Openship`,
    description: PAGE_DESCRIPTION,
  },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return inheritSocialImages(metadata, parent);
}

export default function FeaturesPage() {
  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <MarketingIntro
          eyebrow="Platform features"
          title={
            <>
              From code to production.
              <br />
              <span>Keep it running.</span>
            </>
          }
          description="Deploy applications, run data services, automate delivery, and keep production healthy. All from Openship."
        >
          <span>
            {FEATURES.length} features · {CATEGORY_ORDER.length} categories
          </span>
        </MarketingIntro>

        <div className="site-container ft-catalog">
          <nav className="ft-category-nav" aria-label="Feature categories">
            {CATEGORY_ORDER.map((category) => (
              <Link key={category} href={`#${categoryId(category)}`}>
                {category}
                <span>{FEATURES.filter((feature) => feature.category === category).length}</span>
              </Link>
            ))}
          </nav>
          {CATEGORY_ORDER.map((category) => (
            <MarketingSection
              key={category}
              id={categoryId(category)}
              title={category}
              description={CATEGORY_BLURB[category]}
            >
              <div className="marketing-grid">
                {FEATURES.filter((feature) => feature.category === category).map((feature) => (
                  <FeatureLink key={feature.slug} feature={feature} />
                ))}
              </div>
            </MarketingSection>
          ))}
        </div>
        <MarketingCta />
      </main>
      <Footer />
    </>
  );
}
