import Link from "next/link";
import { ArrowRight, Boxes } from "lucide-react";
import { getMarketplaceApps } from "@/lib/app-catalog";
import { APP_CATEGORY_LABELS } from "@/lib/app-marketplace";
import { MarketplaceLogo } from "@/components/apps/marketplace-logo";

const FEATURED_IDS = [
  "supabase",
  "n8n",
  "ghost",
  "postgresql",
  "nextcloud",
  "gitea",
  "umami",
  "minio",
  "nocodb",
];
const CATEGORIES = ["backend", "database", "cms", "automation", "analytics", "other"] as const;

export async function AppsShowcase() {
  const apps = await getMarketplaceApps();
  const available = apps.filter((app) => app.available);
  const featured = FEATURED_IDS.flatMap((id) => {
    const app = available.find((entry) => entry.id === id);
    return app ? [app] : [];
  });

  return (
    <section id="apps" className="ha-section" aria-labelledby="home-apps-title">
      <div className="ha-container">
        <div className="ha-intro">
          <p className="ha-eyebrow">
            <Boxes className="size-4" aria-hidden="true" /> The app catalog
          </p>
          <h2 id="home-apps-title" className="ha-title">
            Your next app.
            <br />
            <span>Already assembled.</span>
          </h2>
          <p className="ha-description">
            A backend for your next project. A database for your data. The tools your team uses
            every day. Explore ready-to-deploy apps, then choose where they live.
          </p>
          <Link href="/apps" className="th-btn group ha-cta">
            Browse all apps{" "}
            <ArrowRight
              className="size-4 transition-transform group-hover:translate-x-1"
              aria-hidden="true"
            />
          </Link>
          <p className="ha-note">
            {available.length} available templates · Cloud and connected servers
          </p>
          <div className="ha-categories" aria-label="Browse app categories">
            {CATEGORIES.filter((category) =>
              available.some((app) => app.category === category),
            ).map((category) => (
              <Link key={category} href={`/apps?category=${category}`}>
                {APP_CATEGORY_LABELS[category]}
              </Link>
            ))}
          </div>
        </div>

        <div className="ha-grid">
          {featured.map((app) => (
            <Link key={app.id} href={`/apps/${app.id}`} className="ha-card">
              <div className="ha-card-top">
                <MarketplaceLogo
                  id={app.id}
                  logo={app.logo}
                  name={app.name}
                  src={`/app-logos/${app.id}.svg`}
                />
                <ArrowRight className="ha-card-arrow size-4" aria-hidden="true" />
              </div>
              <h3>{app.name}</h3>
              <p>{app.description}</p>
              <span className="ha-card-category">{APP_CATEGORY_LABELS[app.category]}</span>
            </Link>
          ))}
          <Link href="/apps" className="ha-catalog-link">
            Find your next app in the catalog <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
