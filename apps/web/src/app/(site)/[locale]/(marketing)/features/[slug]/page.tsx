import { localizedMetadata } from "@/i18n/metadata";

import { getCopy } from "@/i18n/copy-server";
import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import { Link } from "@/i18n/Link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { Navbar, Footer } from "@/components/landing";
import { FEATURES, getFeature, relatedFeatures } from "../_data";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { FeatureLink } from "../_components/FeatureLink";
import { MarketingCta } from "@/components/marketing/marketing-cta";
import { FeatureShot } from "../_components/FeatureShot";
import "../features.css";

type Params = Promise<{ slug: string }>;

export function generateStaticParams() {
  return FEATURES.map((f) => ({ slug: f.slug }));
}

export async function generateMetadata(
  { params }: { params: Params },
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const { slug } = await params;
  const f = getFeature(slug);
  if (!f) return localizedMetadata(await { title: "Feature — OpenShip" });
  const title = `${f.title} — Features`;
  const metadata: Metadata = {
    title,
    description: f.summary,
    alternates: { canonical: `/features/${f.slug}` },
    openGraph: {
      title: `${f.title} — OpenShip`,
      description: f.summary,
      url: `/features/${f.slug}`,
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title: `${f.title} — OpenShip`,
      description: f.summary,
    },
  };
  return localizedMetadata(await inheritSocialImages(metadata, parent));
}

export default async function FeatureDetailPage({ params }: { params: Params }) {
  const copy = await getCopy();

  const { slug } = await params;
  const feature = getFeature(slug);
  if (!feature) notFound();
  const related = relatedFeatures(feature);

  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <section className="site-container ft-detail-intro">
          <Link href="/features" className="ft-back">
            <ArrowLeft className="size-4" aria-hidden="true" />
            {copy("All features")}
          </Link>
          <div
            className={`ft-detail-lead ${feature.screenshot ? "ft-detail-lead--with-shot" : ""}`}
          >
            <div>
              <div className="ft-detail-heading">
                <FeatureIllustration
                  name={feature.slug}
                  className="marketing-illustration ft-detail-illustration"
                />
                <div>
                  <p className="marketing-eyebrow">{copy(feature.category)}</p>
                  <h1 className="ft-detail-title">{copy(feature.title)}</h1>
                </div>
              </div>
              <p className="ft-detail-summary">{copy(feature.summary)}</p>
              {feature.availability && (
                <p className="ft-availability">{copy(feature.availability)}</p>
              )}
              <Link href={feature.guide} className="ft-guide-link">
                {feature.guide.startsWith("/apps")
                  ? copy("Explore the app catalog")
                  : feature.guide === "/download"
                    ? copy("Choose your download")
                    : copy("Open the guide")}
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
            {feature.screenshot && (
              <FeatureShot
                src={feature.screenshot}
                alt={copy("{value0} in OpenShip", { value0: String(feature.title) })}
                priority
              />
            )}
          </div>
        </section>

        <section className="site-container">
          <div className="ft-detail-content">
            <div className="ft-prose">
              <h2>{copy("How it works")}</h2>
              {feature.body.map((paragraph) => (
                <p key={paragraph}>{copy(paragraph)}</p>
              ))}
            </div>
            <div className="ft-capabilities">
              <h2>{copy("What you can do")}</h2>
              <ul>
                {feature.highlights.map((highlight) => (
                  <li key={highlight.title}>
                    <Check className="ft-check" aria-hidden="true" />
                    <div>
                      <h3>{copy(highlight.title)}</h3>
                      <p>{copy(highlight.desc)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="site-container ft-related">
          <header>
            <h2>{copy("Keep exploring")}</h2>
            <Link href="/features">
              {copy("All features")}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </header>
          <div className="marketing-grid">
            {related.map((feature) => (
              <FeatureLink key={feature.slug} feature={feature} />
            ))}
          </div>
        </section>
        <MarketingCta />
      </main>
      <Footer />
    </>
  );
}
