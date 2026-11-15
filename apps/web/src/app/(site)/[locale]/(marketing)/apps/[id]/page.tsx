import { localizedMetadata } from "@/i18n/metadata";

import { getCopy } from "@/i18n/copy-server";
import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import { Link } from "@/i18n/Link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Check, ArrowRight, Layers, Database } from "lucide-react";
import { APP_TEMPLATES, CLOUD_DASHBOARD_URL } from "@repo/core";
import { getMarketplaceApps } from "@/lib/app-catalog";
import { APP_CATEGORY_LABELS } from "@/lib/app-marketplace";
import { renderAppArticle } from "@/lib/app-markdown";
import { MarketplaceLogo } from "@/components/apps/marketplace-logo";
import { AppHostingNote, MarketplaceAppLink } from "@/components/apps/marketplace-app-link";

export const revalidate = 600;
export function generateStaticParams() {
  return APP_TEMPLATES.filter((app) => !app.unlisted).map((app) => ({ id: app.id }));
}

export async function generateMetadata(
  {
    params,
  }: {
    params: Promise<{ id: string }>;
  },
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const { id } = await params;
  const app = (await getMarketplaceApps()).find((app) => app.id === id);
  if (!app) return localizedMetadata(await {});
  const title = `${app.name} — App catalog`;
  const metadata: Metadata = {
    title,
    description: app.description,
    alternates: { canonical: `/apps/${app.id}` },
    openGraph: {
      title: `${app.name} — OpenShip`,
      description: app.description,
      url: `/apps/${app.id}`,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: `${app.name} — OpenShip`,
      description: app.description,
    },
  };
  return localizedMetadata(await inheritSocialImages(metadata, parent));
}

export default async function AppPage({ params }: { params: Promise<{ id: string }> }) {
  const copy = await getCopy();

  const { id } = await params;
  const apps = await getMarketplaceApps();
  const app = apps.find((app) => app.id === id);
  if (!app) notFound();
  const related = apps
    .filter((other) => other.id !== app.id && other.category === app.category && other.available)
    .slice(0, 3);
  const cloud = app.kind === "template" && app.supportsCloud;
  const installUrl = cloud
    ? `${CLOUD_DASHBOARD_URL}/apps/new/${encodeURIComponent(app.id)}`
    : app.kind === "flow"
      ? "/mail"
      : "/docs/getting-started/installation";
  const article = app.article ? renderAppArticle(app.article) : null;
  const schema = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: app.name,
    description: app.description,
    url: `https://openship.io/apps/${app.id}`,
    applicationCategory: APP_CATEGORY_LABELS[app.category],
    operatingSystem: "Linux",
  };

  return (
    <main className="site-container marketing-page marketplace-main marketplace-detail">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, "\\u003c") }}
      />
      <Link href="/apps" className="marketplace-back">
        <ArrowLeft size={16} /> {copy(" All apps")}
      </Link>
      <header className="marketplace-detail-header">
        <MarketplaceLogo id={app.id} logo={app.logo} name={app.name} large />
        <div className="min-w-0">
          <Link href={`/apps?category=${app.category}`} className="marketing-eyebrow">
            {copy(APP_CATEGORY_LABELS[app.category])}
          </Link>
          <h1 className="marketplace-detail-title">
            <bdi>{app.name}</bdi>
          </h1>
          <AppHostingNote app={app} />
          <p className="mt-4 max-w-2xl text-lg leading-relaxed th-text-secondary">
            {copy(app.description)}
          </p>
        </div>
      </header>
      <div className="marketplace-detail-grid">
        <div className="min-w-0">
          {app.features.length > 0 && (
            <section
              className="marketplace-feature-grid"
              aria-label={copy("{value0} features", { value0: String(app.name) })}
            >
              {app.features.map((feature) => (
                <div key={feature.title} className="marketplace-feature">
                  <Check size={18} className="th-text-muted" aria-hidden="true" />
                  <h2 className="text-sm font-medium th-text-heading">{copy(feature.title)}</h2>
                  {feature.description && (
                    <p className="mt-2 text-sm leading-relaxed th-text-secondary">
                      {copy(feature.description)}
                    </p>
                  )}
                </div>
              ))}
            </section>
          )}
          {article ? (
            <article
              className="marketplace-prose"
              aria-label={copy("About {value0}", { value0: String(app.name) })}
              dangerouslySetInnerHTML={{ __html: article }}
            />
          ) : (
            <section className="marketplace-prose">
              <h2>
                {copy("Make ")}
                <bdi>{app.name}</bdi> {copy(" part of your stack")}
              </h2>
              <p>
                {app.available
                  ? copy(
                      "The catalog template provides the service configuration so you can focus on using the app. Review its settings, choose an appropriate destination, and deploy through OpenShip.",
                    )
                  : copy(
                      "This app is listed for discovery. Its OpenShip template is not ready to install yet.",
                    )}
              </p>
              {app.repository && (
                <p>
                  {copy("Read the")}{" "}
                  <a href={app.repository} target="_blank" rel="noopener noreferrer">
                    {copy("upstream project")}
                  </a>{" "}
                  {copy("for its capabilities and documentation.")}
                </p>
              )}
            </section>
          )}
          {app.services.length > 0 && (
            <section className="marketplace-included">
              <h2 className="text-xl font-medium th-text-heading">
                {copy("Included in this template")}
              </h2>
              <p className="mt-2 text-sm th-text-secondary">
                {copy("The services configured by the catalog, deployed together as one project.")}
              </p>
              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                {app.services.map((service) => (
                  <div key={service.name} className="marketplace-service">
                    {service.persistent ? (
                      <Database size={17} aria-hidden="true" />
                    ) : (
                      <Layers size={17} aria-hidden="true" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium th-text-strong">
                        <bdi>{service.name}</bdi>
                      </p>
                      <p
                        className="mt-0.5 truncate text-xs th-text-muted"
                        title={copy(service.image)}
                      >
                        {service.image ?? "Built from the catalog template"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          {related.length > 0 && (
            <section className="marketplace-related">
              <h2 className="text-xl font-medium th-text-heading">
                {copy("More ")}
                {APP_CATEGORY_LABELS[app.category].toLowerCase()}
              </h2>
              <div className="marketing-grid mt-5">
                {related.map((other) => (
                  <MarketplaceAppLink key={other.id} app={other} heading="h3" />
                ))}
              </div>
            </section>
          )}
        </div>
        <aside className="marketplace-install">
          <div className="marketplace-install-card">
            <span className="marketplace-label">
              {app.available ? copy("Make it yours") : copy("In the catalog")}
            </span>
            <h2 className="mt-3 text-xl font-medium tracking-tight th-text-heading">
              {app.available
                ? copy("Deploy {value0}", { value0: String(app.name) })
                : copy("Coming soon")}
            </h2>
            <p className="mt-3 text-sm leading-relaxed th-text-secondary">
              {app.available
                ? cloud
                  ? copy(
                      "Use your Cloud plan’s capacity or deploy on your own infrastructure. Review the app’s settings before starting.",
                    )
                  : copy("Set up and manage this app through OpenShip on your own server.")
                : copy(
                    "This template is being prepared. Explore the app now; installation will become available when the catalog marks it ready.",
                  )}
            </p>
            {app.experimental && (
              <p className="mt-4 text-sm th-text-secondary">
                {copy(
                  "This template is experimental. Review its requirements before using it for production.",
                )}
              </p>
            )}
            {app.available && (
              <div className="mt-6 space-y-2">
                <Link href={installUrl} className="marketplace-primary">
                  {cloud ? copy("Deploy on Cloud") : copy("Set up on your server")}
                  <ArrowRight size={16} />
                </Link>
                {cloud && (
                  <Link href="/docs/getting-started/installation" className="marketplace-secondary">
                    {copy("Use your own server ")}
                    <ArrowUpRight size={15} />
                  </Link>
                )}
              </div>
            )}
            {(app.minResources || app.minEngine) && (
              <dl className="marketplace-requirements">
                {app.minResources?.memoryMb && (
                  <div>
                    <dt>{copy("Minimum memory")}</dt>
                    <dd>{app.minResources.memoryMb.toLocaleString()} MB</dd>
                  </div>
                )}
                {app.minResources?.cpuCores && (
                  <div>
                    <dt>{copy("Minimum CPU")}</dt>
                    <dd>{app.minResources.cpuCores} vCPU</dd>
                  </div>
                )}
                {app.minEngine && (
                  <div>
                    <dt>{copy("OpenShip version")}</dt>
                    <dd>
                      {copy(app.minEngine)} {copy(" or newer")}
                    </dd>
                  </div>
                )}
              </dl>
            )}
            {app.tags.length > 0 && (
              <div className="marketplace-tags">
                {app.tags.map((tag) => (
                  <span key={tag}>{copy(tag)}</span>
                ))}
              </div>
            )}
            {app.repository && (
              <a
                href={app.repository}
                className="marketplace-source"
                target="_blank"
                rel="noopener noreferrer"
              >
                {copy("View source project ")}
                <ArrowUpRight size={15} />
              </a>
            )}
          </div>
          <p className="mt-4 px-2 text-xs leading-relaxed th-text-muted">
            {copy(
              "The catalog provides a starting configuration. Review upstream licensing and requirements for your use case.",
            )}
          </p>
        </aside>
      </div>
    </main>
  );
}
