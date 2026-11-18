import { getMarketplaceApps } from "@/lib/app-catalog";
import { APP_CATEGORY_LABELS } from "@/lib/app-marketplace";
import { appMark } from "@/lib/og-marks";
import { subjectForFeature, type CoverObject } from "@/lib/og-objects";
import { getChangelog } from "@/lib/changelog";
import { getFeature } from "@/lib/features";
import { renderOgImage, type ShareCard } from "@/lib/og-image";
import { sectionCard, sectionCards } from "@/lib/share-cards";
import { blogSource } from "@/lib/source";

const articleSubjects: Record<string, CoverObject | undefined> = {
  "how-ai-builds-work": "compiler",
  "self-hosting-cost-breakdown": "costs",
  "introducing-openship": "introduction",
  "openship-0-9-1": "milestone",
};

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
    if (post) {
      const object = articleSubjects[slug];
      const art: ShareCard["art"] = object
        ? { object }
        : { outline: post.data.toc.map((h) => h.url.slice(1).replace(/-/g, " ")) };
      return {
        eyebrow: ["Blog", post.data.category].filter(Boolean).join(" · "),
        title: post.data.title,
        subtitle: post.data.description,
        art,
        layout: "masthead",
        footer: ["openship.io/blog", post.data.date].filter(Boolean).join("  /  "),
      };
    }
  }
  if (path.length !== 2) return;
  if (section === "features") {
    const feature = getFeature(slug);
    if (feature) {
      const object = subjectForFeature(slug);
      return {
        eyebrow: feature.category,
        title: feature.title,
        subtitle: feature.tagline,
        art: object ? { object } : { feature: feature.illustration },
        layout: "reverse",
      };
    }
  }
  if (section === "apps") {
    const app = (await getMarketplaceApps()).find((app) => app.id === slug);
    if (app)
      return {
        eyebrow: APP_CATEGORY_LABELS[app.category],
        title: app.name,
        subtitle: app.description,
        art:
          app.id === "alertmanager"
            ? { object: "alerts" }
            : { marks: [await appMark(app.name, app.id, app.logo)] },
        layout: "reverse",
        footer: `openship.io/apps/${app.id}`,
      };
  }
  if (section === "changelog") {
    const release = (await getChangelog()).find((entry) => entry.slug === slug);
    if (release)
      return {
        eyebrow: "Release notes",
        title: `OpenShip ${release.displayVersion}`,
        subtitle: release.summary,
        art: {
          version: release.displayVersion,
          changes: release.sections.map((section) => section.items.length),
        },
        footer: release.date
          ? `Release notes  /  ${release.date.slice(0, 10)}`
          : "openship.io/changelog",
      };
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const card = await resolveCard((await params).path);
  if (!card) return new Response("Not found", { status: 404 });
  return renderOgImage(card);
}
