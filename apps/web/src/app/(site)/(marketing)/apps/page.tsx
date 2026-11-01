import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import { getMarketplaceApps } from "@/lib/app-catalog";
import { AppDirectory } from "@/components/apps/app-directory";

const description =
  "Find your next backend, database, CMS, or developer tool. Explore ready-to-deploy app templates for Openship Cloud and your own infrastructure.";
const metadata: Metadata = {
  title: "Apps",
  description,
  alternates: { canonical: "/apps" },
  openGraph: { title: "Apps — Openship", description, url: "/apps", type: "website" },
  twitter: { card: "summary_large_image", title: "Apps — Openship", description },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return inheritSocialImages(metadata, parent);
}

export default async function AppsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string | string[]; q?: string | string[] }>;
}) {
  const [apps, params] = await Promise.all([getMarketplaceApps(), searchParams]);
  const category = Array.isArray(params.category) ? params.category[0] : params.category;
  const query = Array.isArray(params.q) ? params.q[0] : params.q;
  // Articles stay on server-rendered detail pages, outside the directory's client payload.
  const cards = apps.map(({ article: _, ...app }) => app);
  return (
    <main className="marketplace-main">
      <header className="marketplace-hero">
        <p className="marketplace-eyebrow">The app catalog</p>
        <h1>
          Your next app,
          <br />
          <span>ready to ship.</span>
        </h1>
        <p className="marketplace-intro">
          Backends, databases, and the tools your projects run on. Explore the app, choose where it
          lives, and make it yours.
        </p>
      </header>
      <AppDirectory apps={cards} initialCategory={category} initialQuery={query?.slice(0, 200)} />
    </main>
  );
}
