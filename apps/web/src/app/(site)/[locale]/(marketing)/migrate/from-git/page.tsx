import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { Navbar, Footer } from "@/components/landing";
import { MarketingIntro } from "@/components/marketing/marketing-intro";
import { MarketingSection } from "@/components/marketing/marketing-section";
import { MarketingCta } from "@/components/marketing/marketing-cta";
import { getCopy } from "@/i18n/copy-server";
import { Link } from "@/i18n/Link";
import { localizedMetadata } from "@/i18n/metadata";
import { MigrationSteps } from "../_components/migration-steps";
import { STEPS } from "../_data";
import "../migrate.css";

const title = "Migrate your repository and data to OpenShip";
const description =
  "Move an application from another hosting platform using its Git repository, container image or Compose file. Plan configuration, data transfer and domain cutover.";

export async function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title,
    description,
    alternates: { canonical: "/migrate/from-git" },
    openGraph: { title, description, url: "/migrate/from-git", type: "website" },
    twitter: { title, description, card: "summary_large_image" },
  });
}

export default async function RepositoryMigrationPage() {
  const copy = await getCopy();
  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <MarketingIntro
          eyebrow={copy("Repository and data migration")}
          title={
            <>
              {copy("Bring your app.")}
              <br />
              <span>{copy("Keep your stack.")}</span>
            </>
          }
          description={copy(
            "Move from Render, Heroku, Netlify, Fly.io, App Platform or another host. Use your repository or image and move data deliberately; this route does not connect to a provider API.",
          )}
        >
          <Link href="/docs/getting-started/first-deployment" className="marketing-text-link mt-6">
            {copy("Deploy your repository")}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </MarketingIntro>
        <div className="site-container marketing-content">
          <MarketingSection
            id="prepare"
            title={copy("Before you switch")}
            description={copy("Inventory services, secrets and persistent data.")}
          >
            <div className="marketing-prose">
              <p>
                {copy(
                  "Record each service's source, build and start commands, port, environment variables and domains. Recreate these in an OpenShip project, or describe multiple services in Compose. Transfer secrets through the project settings, not your repository.",
                )}
              </p>
              <p>
                {copy(
                  "Keep an external database if its network access allows it, or restore a verified export into the destination. Copy uploaded files separately. Check provider-specific functions, storage APIs, redirects and scheduled jobs before moving traffic.",
                )}
              </p>
              <p>
                {copy(
                  "Test on a temporary domain. For a final data copy, pause writes when required and plan the interruption. Keep the source available until you have verified traffic, background jobs and data at the destination.",
                )}
              </p>
              <Link href="/docs/guides/compose-multi-service" className="marketing-text-link">
                {copy("Deploy a Compose stack")}
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </MarketingSection>
          <MarketingSection
            id="steps"
            title={copy("Plan the move")}
            description={copy("Access, compatibility and the final switch.")}
          >
            <MigrationSteps steps={STEPS} />
          </MarketingSection>
          <MarketingSection
            id="help"
            title={copy("Choose your migration path")}
            description={copy("Review the guide for your current platform.")}
          >
            <div className="marketing-prose">
              <p>
                {copy(
                  "Railway and Vercel have guided import flows. Existing Docker servers have a separate discovery and review flow. Use those guides when they match your source.",
                )}
              </p>
              <Link href="/migrate" className="marketing-text-link">
                {copy("Explore all migration options ")}
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
              <br />
              <Link href="/compare" className="marketing-text-link">
                {copy("Compare platforms")}
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </MarketingSection>
        </div>
        <MarketingCta />
      </main>
      <Footer />
    </>
  );
}
