import { getMarketplaceApps } from "@/lib/app-catalog";
import { getChangelog } from "@/lib/changelog";
import { getFeature } from "@/lib/features";
import { renderOgImage, type ShareCard } from "@/lib/og-image";
import { sectionCard, sectionCards } from "@/lib/share-cards";
import { blogSource } from "@/lib/source";

export const revalidate = 600;

export function generateStaticParams() {
  return Object.keys(sectionCards).map((key) => ({ path: key.split("/") }));
}

async function resolveCard(path: string[]): Promise<ShareCard | undefined> {
  const fixed = sectionCard(path.join("/"));
  if (fixed) return fixed;
  const [section, slug] = path;
  if (!slug) return;
  if (section === "blog") {
    const post = blogSource.getPage(path.slice(1), "en");
    if (post)
      return {
        eyebrow: "Blog",
        title: post.data.title,
        subtitle: post.data.description,
        symbol: "book",
      };
  }
  if (path.length !== 2) return;
  if (section === "features") {
    const feature = getFeature(slug);
    if (feature)
      return {
        eyebrow: feature.category,
        title: feature.title,
        subtitle: feature.tagline,
        symbol: "layers",
      };
  }
  if (section === "apps") {
    const app = (await getMarketplaceApps()).find((app) => app.id === slug);
    if (app)
      return { eyebrow: "App catalog", title: app.name, subtitle: app.description, symbol: "apps" };
  }
  if (section === "changelog") {
    const release = (await getChangelog()).find((entry) => entry.slug === slug);
    if (release)
      return {
        eyebrow: "Release notes",
        title: `OpenShip ${release.displayVersion}`,
        subtitle: release.summary,
        symbol: "branch",
      };
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const card = await resolveCard((await params).path);
  if (!card) return new Response("Not found", { status: 404 });
  return renderOgImage(card);
}
