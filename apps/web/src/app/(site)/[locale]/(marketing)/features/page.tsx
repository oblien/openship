import { getCopy } from "@/i18n/copy-server";
import { getLocale } from "next-intl/server";
import type { AppLocale } from "@repo/core/locale";
import { localizedHref } from "@/i18n/routing";
import { SITE_URL } from "@/lib/sitemap-builder";
import { PRODUCT_SUMMARY } from "@/lib/product";
import { ControlPlaneModes, ProductQuestions } from "@/components/marketing/product-overview";
import { StructuredData } from "@/components/marketing/structured-data";
import { localizedMetadata } from "@/i18n/metadata";

import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import { Link } from "@/i18n/Link";
import { Navbar, Footer } from "@/components/landing";
import { FEATURES, CATEGORY_ORDER, CATEGORY_BLURB, categoryId } from "./_data";
import { FeatureLink } from "./_components/FeatureLink";
import { MarketingCta } from "@/components/marketing/marketing-cta";
import { MarketingIntro } from "@/components/marketing/marketing-intro";
import { MarketingSection } from "@/components/marketing/marketing-section";
import "./features.css";

const PAGE_TITLE = "Features";
const PAGE_DESCRIPTION =
  "Explore OpenShip's deployment, CI, runners, apps, backups, migration, networking, monitoring, and team access features, with detailed guides and availability.";

const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/features" },
  openGraph: {
    title: `${PAGE_TITLE} — OpenShip`,
    description: PAGE_DESCRIPTION,
    url: "/features",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${PAGE_TITLE} — OpenShip`,
    description: PAGE_DESCRIPTION,
  },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return localizedMetadata(await inheritSocialImages(metadata, parent));
}

export default async function FeaturesPage() {
  const copy = await getCopy();
  const locale = (await getLocale()) as AppLocale;

  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <StructuredData
          data={{
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "OpenShip",
            url: SITE_URL,
            description: copy(PRODUCT_SUMMARY),
            applicationCategory: "DeveloperApplication",
            operatingSystem: "Linux, macOS, Windows",
            license: "https://www.apache.org/licenses/LICENSE-2.0",
            featureList: FEATURES.map((feature) => copy(feature.title)),
            inLanguage: locale,
          }}
        />
        <StructuredData
          data={{
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: copy("Platform features"),
            itemListElement: CATEGORY_ORDER.flatMap((category) =>
              FEATURES.filter((feature) => feature.category === category),
            ).map((feature, index) => ({
              "@type": "ListItem",
              position: index + 1,
              name: copy(feature.title),
              url: SITE_URL + localizedHref(`/features/${feature.slug}`, locale),
            })),
          }}
        />
        <MarketingIntro
          eyebrow="Platform features"
          title={
            <>
              {copy("From code to production.")}
              <br />
              <span>{copy("Keep it running.")}</span>
            </>
          }
          description={copy(PRODUCT_SUMMARY)}
        >
          <span>
            {copy("{features} features · {categories} categories", {
              features: FEATURES.length,
              categories: CATEGORY_ORDER.length,
            })}
          </span>
        </MarketingIntro>

        <div className="site-container marketing-content">
          <ControlPlaneModes />
        </div>
        <div className="site-container ft-catalog">
          <nav className="ft-category-nav" aria-label={copy("Feature categories")}>
            {CATEGORY_ORDER.map((category) => (
              <Link key={category} href={`#${categoryId(category)}`}>
                {copy(category)}
                <span>{FEATURES.filter((feature) => feature.category === category).length}</span>
              </Link>
            ))}
          </nav>
          {CATEGORY_ORDER.map((category) => (
            <MarketingSection
              key={category}
              id={categoryId(category)}
              title={copy(category)}
              description={copy(CATEGORY_BLURB[category])}
            >
              <div className="marketing-grid">
                {FEATURES.filter((feature) => feature.category === category).map((feature) => (
                  <FeatureLink key={feature.slug} feature={feature} />
                ))}
              </div>
            </MarketingSection>
          ))}
        </div>
        <div className="site-container marketing-content">
          <ProductQuestions />
        </div>
        <MarketingCta />
      </main>
      <Footer />
    </>
  );
}
