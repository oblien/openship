import type { ResolvingMetadata } from "next";
import { CLOUD_DASHBOARD_URL } from "@repo/core";
import { Dashboard, Navbar, Footer, LandingCtaSection } from "@/components/landing";
import { getCopy } from "@/i18n/copy-server";
import { localizedMetadata } from "@/i18n/metadata";
import { cloudMigrationHref } from "@/lib/cloud-links";
import { inheritSocialImages } from "@/lib/social-metadata";
import { CloudPricingSection } from "../pricing/cloud-pricing-section";
import { CommunityStories } from "./community-stories";
import { FeatureHighlights } from "./feature-highlights";
import { MigrationPreview } from "./migration-preview";
import styles from "./capabilities.module.css";

const title = "Docker hosting and full-stack app deployment";
const description =
  "Managed Docker hosting for full-stack apps, APIs and workers. Deploy from Git with Docker Compose on OpenShip Cloud, or migrate from Railway or Vercel.";
const libraryUrl = new URL("/library", CLOUD_DASHBOARD_URL).href;
const composeServices = [
  { service: "web", stack: "Next.js", icon: "web page 1-0-1658436291.png" },
  { service: "api", stack: "Django", icon: "code-21-1658431404.png" },
  { service: "worker", stack: "Node.js", icon: "terminal-57-1658431404.png" },
  { service: "db", stack: "PostgreSQL", icon: "database-27-1658237565.png" },
];

export async function generateMetadata(_props: unknown, parent: ResolvingMetadata) {
  return localizedMetadata(
    await inheritSocialImages(
      {
        title,
        description,
        alternates: { canonical: "/deployments" },
        openGraph: { title, description, url: "/deployments", type: "website" },
        twitter: { title, description, card: "summary_large_image" },
      },
      parent,
    ),
  );
}

export default async function DeploymentsPage() {
  const copy = await getCopy();
  const deployButton = (
    <a href={libraryUrl} className="th-btn rounded-full px-7 py-3">
      {copy("Deploy to OpenShip Cloud")} <span aria-hidden="true">↗</span>
    </a>
  );
  return (
    <>
      <Navbar />
      <main>
        <section className="relative isolate overflow-hidden pt-32 text-center sm:pt-40">
          <div className="site-container relative">
            <h1 className={styles.headline}>{copy("Deploy your full stack.")}</h1>
            <p className="hero-description mx-auto mt-5 max-w-xl text-lg leading-relaxed th-text-body">
              {copy(
                "Deploy your web app, API and background workers from GitHub or GitLab. OpenShip Cloud handles builds, hosting and HTTPS.",
              )}
            </p>
            <div className="hero-actions">
              {deployButton}
              <a href="#plans" className="th-btn-ghost rounded-full px-7 py-3">
                {copy("Explore pricing")} <span aria-hidden="true">↓</span>
              </a>
            </div>
          </div>
          <div className="relative mt-8 sm:mt-14">
            <div className="hero-aurora" aria-hidden="true">
              <div className="hero-aurora-core" />
            </div>
            <Dashboard />
          </div>
        </section>

        <section id="deployment-options" aria-labelledby="compose-title" className={styles.wide}>
          <div className={`site-container ${styles.feature}`}>
            <div className={styles.body}>
              <h2 id="compose-title">{copy("Deploy your whole stack from Git.")}</h2>
              <p>{copy("Define your app, API, worker and database in one Docker Compose file. Enable auto-deploy to ship changes when you push to your deployment branch.")}</p>
              <a className="th-btn rounded-full px-6 py-3" href={libraryUrl}>
                {copy("Deploy a Compose stack")} <span aria-hidden="true">↗</span>
              </a>
            </div>
            <figure className={styles.network} dir="ltr">
              <figcaption className={styles.push}>
                <img src="/icons/git branch-159-1658431404.png" alt="" width={20} height={20} />
                <code>git push origin main</code>
              </figcaption>
              <div className={styles.file}>
                <img src="/icons/document code-1-1658431404.png" alt="" width={22} height={22} />
                <code>compose.yaml</code>
              </div>
              <ul className={styles.services}>
                {composeServices.map(({ service, stack, icon }) => (
                  <li key={service}>
                    <span className={styles.node}><img src={`/icons/${icon}`} alt="" width={24} height={24} /></span>
                    <code>{service}</code>
                    <span className={styles.stack}>{stack}</span>
                  </li>
                ))}
              </ul>
            </figure>
          </div>
        </section>

        <div id="your-servers" className={`site-container ${styles.wide}`}>
          <section id="migration" aria-labelledby="migration-title" className={styles.migration}>
            <div className={styles.body}>
              <h2 id="migration-title">{copy("Migrate your apps from Railway or Vercel.")}</h2>
              <p>{copy("Import your Railway services together or bring the GitHub commit you deployed on Vercel. Review your settings and test your app on OpenShip Cloud before switching traffic.")}</p>
              <a className="th-btn rounded-full px-6 py-3" href={cloudMigrationHref()}>
                {copy("Start your import")} <span aria-hidden="true">↗</span>
              </a>
            </div>
            <MigrationPreview copy={copy} />
          </section>
        </div>

        <CommunityStories />

        <div className={`pp-root pt-14 sm:pt-20 ${styles.wide}`}>
          <CloudPricingSection />
        </div>
        <FeatureHighlights />
        <LandingCtaSection
          className={styles.closing}
          title={copy("Deploy your first app")}
          description={copy("Connect a repository and deploy changes from your chosen branch.")}
          actions={deployButton}
        />
      </main>
      <Footer />
    </>
  );
}
