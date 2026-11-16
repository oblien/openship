import type { Metadata, ResolvingMetadata } from "next";
import { ArrowRight } from "lucide-react";
import { Navbar, Footer } from "@/components/landing";
import { MarketingIntro } from "@/components/marketing/marketing-intro";
import { getSlaSections } from "@/components/marketing/sla-terms";
import { getCopy } from "@/i18n/copy-server";
import { Link } from "@/i18n/Link";
import { localizedMetadata } from "@/i18n/metadata";
import { CLOUD_SLA } from "@/lib/cloud-service";
import { inheritSocialImages } from "@/lib/social-metadata";

const title = "OpenShip Cloud service level agreement";
const description =
  "OpenShip Cloud uptime coverage, service credit tiers and how to submit a claim. The same SLA applies to every paid Cloud plan.";

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return localizedMetadata(
    await inheritSocialImages(
      {
        title: { absolute: title },
        description,
        alternates: { canonical: "/sla" },
        openGraph: { title, description, url: "/sla", type: "article" },
        twitter: { title, description, card: "summary_large_image" },
      },
      parent,
    ),
  );
}

export default async function SlaPage() {
  const copy = await getCopy();
  const sections = getSlaSections(copy);
  const facts = [
    { value: `${CLOUD_SLA.monthlyUptimePercent}%`, label: "Monthly Cloud uptime" },
    {
      value: copy("{days} days", { days: CLOUD_SLA.claimWindowDays }),
      label: "To claim after the affected month",
    },
    {
      value: copy("{days} business days", { days: CLOUD_SLA.claimReviewBusinessDays }),
      label: "To review a complete claim",
    },
  ];
  return (
    <>
      <Navbar />
      <main className="marketing-page legal-root">
        <MarketingIntro
          eyebrow={copy("Service level agreement")}
          title={
            <>
              {copy("Reliability,")}
              <br />
              <span>{copy("in writing.")}</span>
            </>
          }
          description={copy(
            "Every paid Cloud plan includes the same uptime commitment. Here is what is covered, how credits work and how to make a claim.",
          )}
        >
          <Link href="/support" className="marketing-text-link mt-6">
            {copy("Submit a claim")}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </MarketingIntro>
        <div className="site-container pb-14">
          <dl className="grid gap-8 rounded-3xl bg-[var(--th-bg-subtle)] p-8 sm:grid-cols-3 sm:p-10">
            {facts.map((fact) => (
              <div key={fact.label} className="flex min-w-0 flex-col gap-3">
                <dt className="order-2 text-sm leading-relaxed text-[var(--th-text-body)]">
                  {copy(fact.label)}
                </dt>
                <dd className="text-3xl font-medium tracking-tight">
                  <bdi>{fact.value}</bdi>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 max-w-3xl text-sm leading-relaxed text-[var(--th-text-body)]">
            {copy(
              "Applies to paid OpenShip Cloud Spaces. Your own servers, free trials and preview features are outside this SLA. The full coverage and exclusions below apply.",
            )}
          </p>
        </div>
        <section className="legal-body">
          <div className="legal-container">
            <div className="legal-grid">
              <aside className="legal-toc" aria-label={copy("Table of contents")}>
                <p className="legal-toc-title">{copy("On this page")}</p>
                <ol>
                  {sections.map((section, index) => (
                    <li key={section.id}>
                      <a href={`#${section.id}`}>
                        <span className="legal-toc-n">{String(index + 1).padStart(2, "0")}</span>
                        {section.title}
                      </a>
                    </li>
                  ))}
                </ol>
                <Link href="/terms" className="marketing-text-link mt-6">
                  {copy("Terms of service")}
                </Link>
              </aside>
              <article className="legal-article">
                {sections.map((section) => (
                  <section key={section.id} id={section.id} className="legal-section">
                    <header className="legal-section-head">
                      <h2 className="legal-section-title">{section.title}</h2>
                    </header>
                    {section.body.map((paragraph, index) => (
                      <p key={index} className="legal-p">
                        {paragraph}
                      </p>
                    ))}
                  </section>
                ))}
              </article>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
