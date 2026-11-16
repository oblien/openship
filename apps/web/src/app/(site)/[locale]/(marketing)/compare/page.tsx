import type { Metadata, ResolvingMetadata } from "next";
import { getLocale } from "next-intl/server";
import type { AppLocale } from "@repo/core/locale";
import { ArrowRight } from "lucide-react";
import { Navbar, Footer } from "@/components/landing";
import { MarketingIntro } from "@/components/marketing/marketing-intro";
import { MarketingSection } from "@/components/marketing/marketing-section";
import { MarketingCta } from "@/components/marketing/marketing-cta";
import { ProductAdvantages } from "@/components/marketing/product-overview";
import { ComparisonCards } from "@/components/marketing/comparison-cards";
import { StructuredData } from "@/components/marketing/structured-data";
import { getCopy } from "@/i18n/copy-server";
import { Link } from "@/i18n/Link";
import { localizedMetadata } from "@/i18n/metadata";
import { localizedHref } from "@/i18n/routing";
import { COMPARISONS, COMPARISON_GROUPS, comparisonName } from "@/lib/comparisons";
import { SITE_URL } from "@/lib/sitemap-builder";
import { inheritSocialImages } from "@/lib/social-metadata";

const title = "Compare OpenShip with other deployment platforms";
const description =
  "Compare OpenShip with Vercel, Railway, Coolify and more. Explore hosting models, tradeoffs and migration guides for your next deployment platform.";

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return localizedMetadata(
    await inheritSocialImages(
      {
        title,
        description,
        alternates: { canonical: "/compare" },
        openGraph: { title, description, url: "/compare", type: "website" },
        twitter: { title, description, card: "summary_large_image" },
      },
      parent,
    ),
  );
}

export default async function ComparePage() {
  const copy = await getCopy();
  const locale = (await getLocale()) as AppLocale;
  return (
    <>
      <Navbar />
      <main className="marketing-page compare-page">
        <StructuredData
          data={{
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: copy(title),
            itemListElement: COMPARISON_GROUPS.flatMap((group) =>
              COMPARISONS.filter((item) => item.group === group.id),
            ).map((item, index) => ({
              "@type": "ListItem",
              position: index + 1,
              name: copy("OpenShip vs {name}", { name: comparisonName(item, copy) }),
              url: SITE_URL + localizedHref(`/compare/${item.slug}`, locale),
            })),
          }}
        />
        <MarketingIntro
          eyebrow={copy("Compare platforms")}
          title={
            <>
              {copy("Your stack.")}
              <br />
              <span>{copy("Your choice.")}</span>
            </>
          }
          description={copy(
            "Own your infrastructure without assembling an entire platform. OpenShip brings deployments, data, mail and automation together. See where that makes a difference for your stack.",
          )}
        >
          <Link href="/migrate" className="marketing-text-link compare-intro-link">
            {copy("Explore migration guides")}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </MarketingIntro>
        <div className="site-container compare-principles">
          <span>{copy("Managed Cloud or your servers")}</span>
          <span>{copy("Portable container workloads")}</span>
          <span>{copy("Sources you can verify")}</span>
        </div>
        <div className="site-container marketing-content">
          <MarketingSection
            id="openship-advantages"
            title="Why teams move to OpenShip"
            description="More of your stack, under your control."
          >
            <ProductAdvantages items={["control", "orchestration", "automation"]} />
          </MarketingSection>
          {COMPARISON_GROUPS.map((group) => (
            <MarketingSection
              key={group.id}
              id={group.id}
              title={copy(group.title)}
              description={copy(group.description)}
            >
              <ComparisonCards items={COMPARISONS.filter((item) => item.group === group.id)} />
            </MarketingSection>
          ))}
        </div>
        <MarketingCta />
      </main>
      <Footer />
    </>
  );
}
