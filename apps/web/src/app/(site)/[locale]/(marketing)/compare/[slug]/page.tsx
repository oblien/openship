import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale } from "next-intl/server";
import type { AppLocale } from "@repo/core/locale";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Navbar, Footer } from "@/components/landing";
import { MarketingIntro } from "@/components/marketing/marketing-intro";
import { MarketingSection } from "@/components/marketing/marketing-section";
import { MarketingCta } from "@/components/marketing/marketing-cta";
import { ComparisonCards, ComparisonMark } from "@/components/marketing/comparison-cards";
import { StructuredData } from "@/components/marketing/structured-data";
import { getCopy } from "@/i18n/copy-server";
import { Link } from "@/i18n/Link";
import { localizedMetadata } from "@/i18n/metadata";
import { localizedHref } from "@/i18n/routing";
import {
  COMPARISONS,
  COMPARISONS_REVIEWED_AT,
  getComparison,
  comparisonName,
  comparisonRows,
} from "@/lib/comparisons";
import { ControlPlaneModes, ProductAdvantages } from "@/components/marketing/product-overview";
import { SITE_URL } from "@/lib/sitemap-builder";

type Props = { params: Promise<{ slug: string }> };
export const dynamicParams = false;
export function generateStaticParams() {
  return COMPARISONS.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const item = getComparison((await params).slug);
  if (!item) notFound();
  const copy = await getCopy();
  const title = copy("OpenShip vs {name}: comparison and migration", {
    name: comparisonName(item, copy),
  });
  const description = copy(
    "OpenShip vs {name}. {summary} Compare capabilities and plan your migration.",
    { name: comparisonName(item, copy), summary: copy(item.summary) },
  );
  const url = `/compare/${item.slug}`;
  return localizedMetadata({
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "article" },
    twitter: { card: "summary_large_image", title, description },
  });
}

export default async function ComparisonPage({ params }: Props) {
  const item = getComparison((await params).slug);
  if (!item) notFound();
  const copy = await getCopy();
  const locale = (await getLocale()) as AppLocale;
  const name = comparisonName(item, copy);
  const heading = copy("OpenShip vs {name}", { name });
  const related = COMPARISONS.filter(
    (other) => other.slug !== item.slug && other.group === item.group,
  ).slice(0, 3);
  const rows = comparisonRows(item);
  return (
    <>
      <Navbar />
      <main className="marketing-page compare-page">
        <StructuredData
          data={{
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              {
                "@type": "ListItem",
                position: 1,
                name: copy("Compare"),
                item: SITE_URL + localizedHref("/compare", locale),
              },
              {
                "@type": "ListItem",
                position: 2,
                name: heading,
                item: SITE_URL + localizedHref(`/compare/${item.slug}`, locale),
              },
            ],
          }}
        />
        <MarketingIntro
          eyebrow={
            <Link href="/compare" className="compare-back">
              {copy("All comparisons")}
            </Link>
          }
          title={copy.rich("OpenShip vs <provider>{name}</provider>", {
            name,
            provider: (chunks) => <bdi>{chunks}</bdi>,
          })}
          description={copy(item.summary)}
        >
          <div className="compare-actions">
            <Link href={item.migration.href} className="th-btn compare-button">
              {copy("Migrate to OpenShip")}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
            <Link href="/pricing" className="marketing-text-link">
              {copy("View pricing")}
            </Link>
          </div>
        </MarketingIntro>
        <div className="site-container marketing-content">
          <MarketingSection
            id="openship-fit"
            title={copy("Why choose OpenShip")}
            description={copy(item.reason)}
          >
            <ProductAdvantages items={item.advantages} />
          </MarketingSection>
          <MarketingSection
            id="differences"
            title={copy("The practical differences")}
            description={copy("Compare the operating model, not just a checklist.")}
          >
            <div className="compare-table-wrap" tabIndex={0} role="region" aria-label={heading}>
              <table className="compare-table">
                <caption className="sr-only">{heading}</caption>
                <thead>
                  <tr>
                    <th scope="col">{copy("What matters")}</th>
                    <th scope="col">
                      <bdi>OpenShip</bdi>
                    </th>
                    <th scope="col">
                      <bdi>{name}</bdi>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.label}>
                      <th scope="row">{copy(row.label)}</th>
                      <td>
                        <span className="compare-mobile-label" aria-hidden="true">
                          <bdi>OpenShip</bdi>
                        </span>
                        {copy(row.ours)}
                      </td>
                      <td>
                        <span className="compare-mobile-label" aria-hidden="true">
                          <bdi>{name}</bdi>
                        </span>
                        {copy(row.theirs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="compare-note">
              {copy(
                "Compare total cost using your actual workload, including compute, storage, transfer and operations. Plan limits and provider pricing can change.",
              )}{" "}
              <Link href="/pricing">{copy("OpenShip pricing")}</Link>
            </p>
          </MarketingSection>
          <ControlPlaneModes />
          <MarketingSection id="provider-fit" title={copy("Where {name} fits", { name })}>
            <div className="compare-provider-fit">
              <ComparisonMark comparison={item} />
              <p>{copy(item.strength)}</p>
            </div>
          </MarketingSection>
          <MarketingSection
            id="migration"
            title={copy("Plan your move")}
            description={copy(item.migration.method)}
          >
            <div className="compare-migration">
              <h3>{copy("Before you switch")}</h3>
              <p>{copy(item.migration.preparation)}</p>
              <ol>
                <li>{copy("Inventory services, secrets and persistent data.")}</li>
                <li>
                  {copy("Deploy and test on a temporary domain. Verify a backup and restore.")}
                </li>
                <li>{copy("Schedule the data cutover, switch DNS and keep a rollback plan.")}</li>
              </ol>
              <Link href={item.migration.href} className="th-btn compare-button">
                {copy("Open migration guide")}
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </MarketingSection>
          <MarketingSection
            id="sources"
            title={copy("Check the details")}
            description={copy("Official sources and scope of this comparison.")}
          >
            <div className="compare-sources">
              <p>
                {copy(
                  "Published by OpenShip. Provider capabilities are based on the official documentation linked below; recommendations reflect the workflows described here.",
                )}
              </p>
              <p>
                {copy("Reviewed on {date}", {
                  date: new Intl.DateTimeFormat(locale, {
                    dateStyle: "long",
                    timeZone: "UTC",
                  }).format(new Date(COMPARISONS_REVIEWED_AT)),
                })}
              </p>
              <ul>
                {item.sources.map((source) => (
                  <li key={source.href}>
                    <a href={source.href} target="_blank" rel="noopener noreferrer">
                      <bdi>{copy(source.title)}</bdi>
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </a>
                  </li>
                ))}
                <li>
                  <Link href="/docs">
                    {copy("OpenShip documentation")}
                    <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                </li>
                <li>
                  <Link href="/sla">
                    {copy("Cloud SLA")}
                    <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                </li>
              </ul>
            </div>
          </MarketingSection>
          {related.length > 0 && (
            <MarketingSection
              id="more"
              title={copy("Keep comparing")}
              description={copy("Explore other options for your stack.")}
            >
              <div className="compare-related">
                <ComparisonCards items={related} />
              </div>
            </MarketingSection>
          )}
        </div>
        <MarketingCta />
      </main>
      <Footer />
    </>
  );
}
