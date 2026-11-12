import { useCopy } from "@/i18n/use-copy";
import { localizedMetadata } from "@/i18n/metadata";

import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import { Link } from "@/i18n/Link";
import { ArrowRight } from "lucide-react";
import { Navbar, Footer } from "@/components/landing";
import { MarketingIntro } from "@/components/marketing/marketing-intro";
import { MarketingSection } from "@/components/marketing/marketing-section";
import { MarketingCta } from "@/components/marketing/marketing-cta";
import { IllustratedLink } from "@/components/marketing/illustrated-link";

const PAGE_TITLE = "About";
const PAGE_DESCRIPTION =
  "OpenShip is an open-source deployment platform built and maintained by the team at Oblien. Apache 2.0, source on GitHub, yours to run anywhere.";

const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/about" },
  openGraph: {
    title: `${PAGE_TITLE} - OpenShip`,
    description: PAGE_DESCRIPTION,
    url: "/about",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${PAGE_TITLE} - OpenShip`,
    description: PAGE_DESCRIPTION,
  },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return localizedMetadata(await inheritSocialImages(metadata, parent));
}

export default function AboutPage() {
  const copy = useCopy();

  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <MarketingIntro
          eyebrow="About OpenShip"
          title={
            <>
              {copy("Built in the open.")}
              <br />
              <span>{copy("Yours to run.")}</span>
            </>
          }
          description={copy(
            "Deployment, data, and operations in one open-source platform. Built and maintained by the team at Oblien.",
          )}
        />
        <div className="site-container marketing-content">
          <MarketingSection
            id="what"
            title={copy("One platform")}
            description={copy("From your first deployment to the services your team relies on.")}
          >
            <div className="marketing-grid">
              <IllustratedLink
                illustration="deploy-anywhere"
                title={copy("Choose where it runs")}
                description={copy(
                  "Use OpenShip Cloud or connect your own infrastructure. Manage apps, data, domains, and backups together.",
                )}
                href="/features/deploy-anywhere"
              />
              <IllustratedLink
                illustration="dashboard-cli-desktop"
                title={copy("Work your way")}
                description={copy(
                  "Use the dashboard, desktop app, CLI, or API. Each connects to the same deployment and management tools.",
                )}
                href="/features/dashboard-cli-desktop"
              />
            </div>
          </MarketingSection>
          <MarketingSection
            id="open-source"
            title={copy("Open from the start")}
            description={copy("Read the code. Run it yourself. Help shape what comes next.")}
          >
            <div className="marketing-prose">
              <p>
                {copy(
                  "OpenShip is open source under the Apache License 2.0. The dashboard, CLI, and platform code are public on GitHub, so you can inspect how it works and contribute improvements.",
                )}
              </p>
              <p>
                {copy(
                  "Deployments use standard containers. Self-host the platform on your own infrastructure, or choose OpenShip Cloud when you want managed hosting.",
                )}
              </p>
              <a href="https://github.com/oblien/openship" className="marketing-text-link">
                {copy("Explore the source ")}
                <ArrowRight size={16} aria-hidden="true" />
              </a>
            </div>
          </MarketingSection>
          <MarketingSection
            id="who"
            title={copy("The team behind it")}
            description={copy("Built and maintained by Oblien.")}
          >
            <div className="marketing-prose">
              <p>
                {copy("OpenShip is built by ")}
                <a href="https://oblien.com">{copy("Oblien LLC")}</a>
                {copy(
                  ", a team working on cloud and developer infrastructure. We also operate OpenShip Cloud.",
                )}
              </p>
              <p>
                {copy(
                  "The platform stays open under Apache 2.0 and free to self-host. Cloud provides a managed option for teams who want to focus on their applications.",
                )}
              </p>
              <Link href="/contact" className="marketing-text-link">
                {copy("Talk to the team ")}
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </MarketingSection>
          <MarketingSection
            id="involved"
            title={copy("Build with us")}
            description={copy("Good feedback makes the platform better for everyone.")}
          >
            <div className="marketing-grid">
              <IllustratedLink
                illustration="configuration-as-code"
                title={copy("Contribute to OpenShip")}
                description={copy(
                  "Report a bug, suggest a feature, improve a guide, or send a pull request.",
                )}
                href="https://github.com/oblien/openship"
              />
              <IllustratedLink
                illustration="app-catalog"
                title={copy("Grow the app catalog")}
                description={copy("Share a useful app template so other teams can deploy it too.")}
                href="/docs/guides/add-an-app"
              />
            </div>
          </MarketingSection>
        </div>
        <MarketingCta />
      </main>
      <Footer />
    </>
  );
}
